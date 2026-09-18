import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Punishment } from '../../database/models/Punishment.js';
import { Ticket } from '../../database/models/Ticket.js';
import { StaffActivity } from '../../database/models/StaffActivity.js';
import { Permission, Emojis } from '../../config/constants.js';
import { resolveStaff, rankLabel } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel } from '../../utils/embeds.js';
import { fullTimestamp } from '../../utils/time.js';
import { UserError } from '../../core/errors.js';

/**
 * What a staff member can do, and what they have been doing.
 *
 * The permission list is generated from live config rather than documented
 * anywhere, so this is also the answer to "why can't I run that command?".
 */
export const data = new SlashCommandBuilder()
  .setName('staffinfo')
  .setDescription('Show a staff member’s rank, permissions and activity')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addUserOption((o) => o.setName('member').setDescription('Defaults to you'))
  .addIntegerOption((o) =>
    o
      .setName('days')
      .setDescription('Activity window (default 30)')
      .setMinValue(1)
      .setMaxValue(365),
  );

export const meta = { permission: Permission.STAFF_INFO, cooldown: 3 };

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const member = interaction.options.getMember('member') ?? interaction.member;
  if (!member) throw new UserError('That member is not in the server.');

  const days = interaction.options.getInteger('days') ?? 30;
  const since = new Date(Date.now() - days * 86_400_000);
  const guildId = interaction.guildId;

  const staff = await resolveStaff(member);

  const [recentActions, ticketsClosed, ticketsClaimed, actionBreakdown] = await Promise.all([
    Punishment.countDocuments({ guildId, moderatorId: member.id, createdAt: { $gte: since } }),
    Ticket.countDocuments({ guildId, closedBy: member.id, closedAt: { $gte: since } }),
    Ticket.countDocuments({ guildId, claimedBy: member.id, claimedAt: { $gte: since } }),
    Punishment.aggregate([
      { $match: { guildId, moderatorId: member.id, createdAt: { $gte: since } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const embed = embeds
    .brand(`${Emojis.SHIELD} Staff profile`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      field('Member', userLabel(member.user), true),
      field('Rank', rankLabel(staff), true),
      field('Joined server', member.joinedAt ? fullTimestamp(member.joinedAt).split(' (')[0] : '—', true),
    );

  if (!staff.isStaff) {
    embed.addFields(
      field('Status', 'Not staff — holds no role mapped to a rank in `/config ranks`.'),
    );
    return interaction.editReply({ embeds: [embed] });
  }

  embed.addFields(
    field(
      `Activity (last ${days} days)`,
      `Moderation actions **${recentActions}**\n` +
        `Tickets claimed **${ticketsClaimed}** · closed **${ticketsClosed}**`,
    ),
  );

  if (actionBreakdown.length) {
    embed.addFields(
      field('Breakdown', actionBreakdown.map((a) => `${a._id}: **${a.count}**`).join(' · ')),
    );
  }

  // All-time totals come from the StaffActivity counters. `/staff activity`
  // shows the full breakdown; this is the summary line.
  const lifetime = await StaffActivity.findOne({ guildId, userId: member.id }).lean();
  embed.addFields(
    field(
      'All time',
      `Actions **${lifetime?.totals?.actions ?? 0}** · ` +
        `Tickets closed **${lifetime?.tickets?.closed ?? 0}** · ` +
        `Bugs closed **${lifetime?.qa?.reportsClosed ?? 0}**\n` +
        'Full breakdown: `/staff activity`',
    ),
  );

  const permissions = staff.permissions.has(Permission.ALL)
    ? ['**Everything** (wildcard)']
    : [...staff.permissions].sort().map((p) => `\`${p}\``);

  embed.addFields(field(`Permissions (${permissions.length})`, permissions.join(' ')));

  if (staff.protected) {
    embed.setFooter({
      text: 'Protected rank — security systems will not act against this member automatically',
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
