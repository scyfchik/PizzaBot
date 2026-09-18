import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Punishment } from '../../database/models/Punishment.js';
import { Ticket } from '../../database/models/Ticket.js';
import { StaffActivity } from '../../database/models/StaffActivity.js';
import { Permission, Emojis } from '../../config/constants.js';
import { resolveStaff, rankLabel, hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel } from '../../utils/embeds.js';
import { timestamp, formatDuration } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Staff activity and leaderboard.
 *
 * Both read the `StaffActivity` counter collection — never the logs. See
 * `systems/staff/StaffActivityService.js` for why.
 *
 * Anyone on staff can see their own numbers; seeing someone else's needs
 * `staff.activity`. That split matters: knowing how you are doing is normal,
 * and comparing colleagues is a lead's job.
 */
export const data = new SlashCommandBuilder()
  .setName('staff')
  .setDescription('Staff activity tools')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('profile')
      .setDescription('Rank, permissions and recent activity')
      .addUserOption((o) => o.setName('member').setDescription('Defaults to you'))
      .addIntegerOption((o) =>
        o.setName('days').setDescription('Activity window (default 30)').setMinValue(1).setMaxValue(365),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('activity')
      .setDescription('Show a staff member’s activity')
      .addUserOption((o) => o.setName('member').setDescription('Defaults to you')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Most active staff by total actions')
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many to show (default 10)').setMinValue(3).setMaxValue(25),
      ),
  );

export const meta = {
  // Every staff member may run this; viewing others is checked per-subcommand.
  permission: Permission.TICKET_CLAIM,
  cooldown: 5,
};

export async function execute(interaction, { client, staff }) {
  const activity = client.getSystem('staffActivity');
  const sub = interaction.options.getSubcommand();

  if (sub === 'leaderboard') return leaderboard(interaction, activity, staff);
  if (sub === 'profile') return staffProfile(interaction, staff);
  return activityPanel(interaction, activity, staff);
}

/**
 * Rank and permissions.
 *
 * The permission list is generated from live config, so this doubles as the
 * answer to "why can't I run that command?".
 */
async function staffProfile(interaction, staff) {
  const member = interaction.options.getMember('member') ?? interaction.member;
  if (!member) throw new UserError('That member is not in the server.');

  const isSelf = member.id === interaction.user.id;
  if (!isSelf && !hasPermission(staff, Permission.STAFF_INFO)) {
    throw new PermissionError("You can view your own profile, but not another staff member's.");
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const days = interaction.options.getInteger('days') ?? 30;
  const since = new Date(Date.now() - days * 86_400_000);
  const guildId = interaction.guildId;

  const [target, recentActions, ticketsClosed, breakdown, lifetime] = await Promise.all([
    resolveStaff(member),
    Punishment.countDocuments({ guildId, moderatorId: member.id, createdAt: { $gte: since } }),
    Ticket.countDocuments({ guildId, closedBy: member.id, closedAt: { $gte: since } }),
    Punishment.aggregate([
      { $match: { guildId, moderatorId: member.id, createdAt: { $gte: since } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    StaffActivity.findOne({ guildId, userId: member.id }).lean(),
  ]);

  const embed = embeds
    .brand(`${Emojis.SHIELD} Staff profile`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      field('Member', userLabel(member.user), true),
      field('Rank', rankLabel(target), true),
      field(
        'Joined server',
        member.joinedAt ? timestamp(member.joinedAt, 'R') : '—',
        true,
      ),
    );

  if (!target.isStaff) {
    embed.addFields(
      field('Status', 'Not staff — holds no role mapped to a rank in `/config rank`.'),
    );
    return interaction.editReply({ embeds: [embed] });
  }

  embed.addFields(
    field(
      `Last ${days} days`,
      `Moderation actions **${recentActions}** · Tickets closed **${ticketsClosed}**` +
        (breakdown.length ? `\n${breakdown.map((b) => `${b._id}: **${b.count}**`).join(' · ')}` : ''),
    ),
    field(
      'All time',
      `Actions **${lifetime?.totals?.actions ?? 0}** · ` +
        `Tickets closed **${lifetime?.tickets?.closed ?? 0}** · ` +
        `Bugs closed **${lifetime?.qa?.reportsClosed ?? 0}**\nBreakdown: \`/staff activity\``,
    ),
  );

  const permissions = target.permissions.has(Permission.ALL)
    ? ['**Everything** (wildcard)']
    : [...target.permissions].sort().map((p) => `\`${p}\``);
  embed.addFields(field(`Permissions (${permissions.length})`, permissions.join(' ')));

  if (target.protected) {
    embed.setFooter({
      text: 'Protected rank — security systems will not act against this member automatically.',
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function activityPanel(interaction, activity, staff) {
  const member = interaction.options.getMember('member') ?? interaction.member;
  if (!member) throw new UserError('That member is not in the server.');

  const isSelf = member.id === interaction.user.id;
  if (!isSelf && !hasPermission(staff, Permission.STAFF_ACTIVITY)) {
    throw new PermissionError("You can view your own activity, but not another staff member's.");
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [record, rank, targetStaff] = await Promise.all([
    activity.get(interaction.guildId, member.id),
    activity.rankOf(interaction.guildId, member.id),
    resolveStaff(member),
  ]);

  if (!record) {
    throw new UserError(
      isSelf
        ? 'You have no recorded activity yet.'
        : `${member.user.username} has no recorded activity yet.`,
    );
  }

  const tickets = record.tickets ?? {};
  const moderation = record.moderation ?? {};
  const qa = record.qa ?? {};

  // The virtual is lost through .lean(), so compute it here.
  const averageMs = tickets.responseSamples
    ? Math.round(tickets.responseTimeTotalMs / tickets.responseSamples)
    : null;

  const embed = embeds
    .brand(`${Emojis.CHART} Staff Activity`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      field('Staff member', userLabel(member.user), true),
      field('Rank', rankLabel(targetStaff), true),
      field('Leaderboard', rank ? `#${rank}` : '—', true),
      field(
        '🎫 Tickets',
        `Claimed **${tickets.claimed ?? 0}**\n` +
          `Closed **${tickets.closed ?? 0}**\n` +
          `Released **${tickets.unclaimed ?? 0}**\n` +
          `Avg. response **${averageMs != null ? formatDuration(averageMs) || '<1m' : 'no data'}**`,
        true,
      ),
      field(
        '🛡️ Moderation',
        `Warnings **${moderation.warns ?? 0}**\n` +
          `Timeouts **${moderation.timeouts ?? 0}**\n` +
          `Kicks **${moderation.kicks ?? 0}**\n` +
          `Bans **${moderation.bans ?? 0}**`,
        true,
      ),
      field(
        '🐛 QA',
        `Reports handled **${qa.reportsHandled ?? 0}**\n` +
          `Reports closed **${qa.reportsClosed ?? 0}**\n` +
          `Marked fixed **${qa.reportsFixed ?? 0}**`,
        true,
      ),
      field('Total actions', `**${record.totals?.actions ?? 0}**`, true),
      field(
        'Last activity',
        record.lastActivityAt
          ? `${timestamp(record.lastActivityAt, 'R')}\n${record.lastAction ?? ''}`
          : 'Never',
        true,
      ),
    )
    .setFooter({ text: 'Counters are indicative. Case and ticket records are authoritative.' });

  await interaction.editReply({ embeds: [embed] });
}

async function leaderboard(interaction, activity, staff) {
  if (!hasPermission(staff, Permission.STAFF_LEADERBOARD)) {
    throw new PermissionError('The leaderboard is for staff leads.');
  }

  await interaction.deferReply();

  const limit = interaction.options.getInteger('limit') ?? 10;
  const rows = await activity.leaderboard(interaction.guildId, limit);

  if (!rows.length) throw new UserError('No staff activity recorded yet.');

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((row, i) => {
    const place = medals[i] ?? `**${i + 1}.**`;
    const t = row.tickets ?? {};
    const m = row.moderation ?? {};
    return (
      `${place} <@${row.userId}> — **${row.totals?.actions ?? 0}** actions\n` +
      `└ ${t.closed ?? 0} tickets closed · ${(m.warns ?? 0) + (m.timeouts ?? 0) + (m.kicks ?? 0) + (m.bans ?? 0)} mod actions · ${row.qa?.reportsClosed ?? 0} bugs closed`
    );
  });

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.TROPHY} Staff Leaderboard`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `Top ${rows.length} by total recorded actions` }),
    ],
  });
}
