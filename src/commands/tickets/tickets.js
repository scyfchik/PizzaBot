import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Ticket } from '../../database/models/Ticket.js';
import { Permission, TicketStatus, TicketCategory, Emojis } from '../../config/constants.js';
import { statusLabel } from '../../systems/tickets/components.js';
import { embeds, field, padNumber, truncate } from '../../utils/embeds.js';
import { timestamp } from '../../utils/time.js';
import { UserError } from '../../core/errors.js';

/**
 * The support queue.
 *
 * `/ticket` acts on one ticket; `/tickets` looks across all of them. Keeping
 * the two apart means neither command grows a confusing mix of "this channel"
 * and "the whole server" subcommands.
 *
 * Every query is paginated and indexed. Listing a year of tickets must never
 * pull a year of tickets into memory to render ten lines.
 */
export const data = new SlashCommandBuilder()
  .setName('tickets')
  .setDescription('Browse the support queue')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List tickets')
      .addStringOption((o) =>
        o
          .setName('status')
          .setDescription('Filter by status')
          .addChoices(
            { name: 'Open (unclaimed)', value: TicketStatus.OPEN },
            { name: 'Claimed', value: TicketStatus.CLAIMED },
            { name: 'Closed', value: TicketStatus.CLOSED },
          ),
      )
      .addStringOption((o) =>
        o
          .setName('category')
          .setDescription('Filter by category')
          .addChoices(
            { name: '🐛 Bug Report', value: TicketCategory.BUG_REPORT },
            { name: '🚨 Player Report', value: TicketCategory.PLAYER_REPORT },
            { name: '⚖️ Ban Appeal', value: TicketCategory.BAN_APPEAL },
            { name: '💳 Purchase Issue', value: TicketCategory.PURCHASE_ISSUE },
            { name: '📋 Staff Application', value: TicketCategory.STAFF_APPLICATION },
            { name: '❓ General Support', value: TicketCategory.GENERAL },
          ),
      )
      .addUserOption((o) => o.setName('handler').setDescription('Filter by handling staff member'))
      .addUserOption((o) => o.setName('opener').setDescription('Filter by who opened it'))
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  )
  .addSubcommand((sub) =>
    sub.setName('queue').setDescription('Tickets waiting for a staff member right now'),
  )
  .addSubcommand((sub) => sub.setName('stats').setDescription('Support volume and response times'));

export const meta = {
  permission: Permission.TICKET_CLAIM,
  cooldown: 4,
};

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();
  if (sub === 'queue') return queue(interaction);
  if (sub === 'stats') return stats(interaction);
  return list(interaction);
}

const PER_PAGE = 10;

async function list(interaction) {
  const guildId = interaction.guildId;
  const query = { guildId };

  const status = interaction.options.getString('status');
  if (status) query.status = status;

  const category = interaction.options.getString('category');
  if (category) query.category = category;

  const handler = interaction.options.getUser('handler');
  if (handler) query.claimedBy = handler.id;

  const opener = interaction.options.getUser('opener');
  if (opener) query.openerId = opener.id;

  const page = interaction.options.getInteger('page') ?? 1;

  const [items, total] = await Promise.all([
    Ticket.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * PER_PAGE)
      .limit(PER_PAGE)
      .lean(),
    Ticket.countDocuments(query),
  ]);

  if (!items.length) throw new UserError('No tickets match that filter.');

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`🎫 Tickets — ${total} total`)
        .setDescription(items.map(ticketLine).join('\n\n'))
        .setFooter({ text: `Page ${page} of ${Math.max(1, Math.ceil(total / PER_PAGE))}` }),
    ],
  });
}

async function queue(interaction) {
  const items = await Ticket.find({
    guildId: interaction.guildId,
    status: TicketStatus.OPEN,
  })
    .sort({ createdAt: 1 }) // oldest first — longest wait goes to the top
    .limit(15)
    .lean();

  if (!items.length) {
    return interaction.editReply({
      embeds: [embeds.success('Queue is clear — every open ticket is claimed.')],
    });
  }

  const oldest = Date.now() - new Date(items[0].createdAt).getTime();

  await interaction.editReply({
    embeds: [
      embeds
        .warning(`${items.length} ticket(s) waiting for a staff member`)
        .setDescription(items.map(ticketLine).join('\n\n'))
        .setFooter({
          text:
            oldest > 3 * 3_600_000
              ? 'The oldest has been waiting over three hours.'
              : 'Oldest first.',
        }),
    ],
  });
}

async function stats(interaction) {
  const guildId = interaction.guildId;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [byStatus, byCategory, responses, openNow] = await Promise.all([
    Ticket.aggregate([
      { $match: { guildId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Ticket.aggregate([
      { $match: { guildId, createdAt: { $gte: weekAgo } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Ticket.aggregate([
      { $match: { guildId, firstResponseMs: { $ne: null } } },
      {
        $group: {
          _id: null,
          avgResponse: { $avg: '$firstResponseMs' },
          avgResolution: { $avg: '$resolutionTimeMs' },
          samples: { $sum: 1 },
        },
      },
    ]),
    Ticket.countDocuments({ guildId, status: { $ne: TicketStatus.CLOSED } }),
  ]);

  const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
  const r = responses[0];

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.CHART} Support statistics`)
        .addFields(
          field('Open now', String(openNow), true),
          field('Closed all time', String(counts.closed ?? 0), true),
          field('Unclaimed', String(counts.open ?? 0), true),
          field(
            'Average first response',
            r?.samples ? humanMs(r.avgResponse) : 'no data yet',
            true,
          ),
          field(
            'Average time to close',
            r?.samples ? humanMs(r.avgResolution) : 'no data yet',
            true,
          ),
          field('Sampled from', r?.samples ? `${r.samples} tickets` : '—', true),
          field(
            'Last 7 days by category',
            byCategory.length
              ? byCategory.map((c) => `${c._id}: **${c.count}**`).join('\n')
              : 'No tickets this week.',
          ),
        ),
    ],
  });
}

function ticketLine(t) {
  return (
    `${statusLabel(t.status)} \`#${padNumber(t.ticketId)}\` **${t.category}** · ${timestamp(t.createdAt, 'R')}\n` +
    `└ by <@${t.openerId}>` +
    (t.claimedBy ? ` · handled by <@${t.claimedBy}>` : '') +
    (t.status !== TicketStatus.CLOSED && t.channelId ? ` · <#${t.channelId}>` : '') +
    (t.closeReason ? `\n└ ${truncate(t.closeReason, 80)}` : '')
  );
}

function humanMs(ms) {
  if (ms == null) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
