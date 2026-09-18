import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Punishment } from '../../database/models/Punishment.js';
import { Ticket } from '../../database/models/Ticket.js';
import { StaffNote } from '../../database/models/StaffNote.js';
import { User } from '../../database/models/User.js';
import { RobloxProfile } from '../../database/models/RobloxProfile.js';
import { Permission, PunishmentType, TicketStatus } from '../../config/constants.js';
import { caseLine } from '../../systems/moderation/caseEmbeds.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, padNumber, userLabel } from '../../utils/embeds.js';
import { fullTimestamp, accountAgeDays } from '../../utils/time.js';

/**
 * The full picture on one member: punishments, tickets, notes, Roblox link.
 *
 * This is the command staff run before making a decision, so it pulls from
 * every collection rather than making them run four lookups.
 */
export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription("Show a member's full record")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Who to look up').setRequired(true))
  .addBooleanOption((o) =>
    o.setName('public').setDescription('Post visibly in the channel (default: only you)'),
  );

export const meta = { permission: Permission.MOD_HISTORY, cooldown: 3 };

export async function execute(interaction, { staff }) {
  const isPublic = interaction.options.getBoolean('public') ?? false;
  await interaction.deferReply({ flags: isPublic ? undefined : MessageFlags.Ephemeral });

  const user = interaction.options.getUser('user');
  const guildId = interaction.guildId;

  const [cases, profile, roblox, tickets, notes] = await Promise.all([
    Punishment.find({ guildId, userId: user.id }).sort({ createdAt: -1 }).limit(10).lean(),
    User.findOne({ guildId, discordId: user.id }).lean(),
    RobloxProfile.findOne({ discordId: user.id }).lean(),
    Ticket.find({ guildId, openerId: user.id }).sort({ createdAt: -1 }).limit(5).lean(),
    hasPermission(staff, Permission.STAFF_NOTES)
      ? StaffNote.find({ guildId, userId: user.id }).sort({ pinned: -1, createdAt: -1 }).limit(5).lean()
      : [],
  ]);

  const totalCases = await Punishment.countDocuments({ guildId, userId: user.id });
  const member = interaction.options.getMember('user');

  const stats = profile?.stats ?? {};
  const activeCases = cases.filter((c) => c.active).length;

  const embed = embeds
    .brand(`Record for ${user.tag}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      field('User', userLabel(user), true),
      field(
        'Account age',
        `${accountAgeDays(user.createdAt)} days\n${fullTimestamp(user.createdAt).split(' (')[0]}`,
        true,
      ),
      field('Joined', member?.joinedAt ? fullTimestamp(member.joinedAt).split(' (')[0] : 'Not in server', true),
      field(
        'Totals',
        `Warns **${stats.warns ?? 0}** · Timeouts **${stats.timeouts ?? 0}** · ` +
          `Kicks **${stats.kicks ?? 0}** · Bans **${stats.bans ?? 0}**\n` +
          `${totalCases} case(s) on record, ${activeCases} active`,
      ),
    );

  if (roblox?.username) {
    embed.addFields(
      field(
        'Roblox',
        `**${roblox.username}**${roblox.robloxId ? ` (\`${roblox.robloxId}\`)` : ''}\n` +
          `${roblox.verified ? '✅ verified' : '⚠️ unverified — self-reported'}` +
          `${roblox.isTester ? ' · Tester' : ''}`,
        true,
      ),
    );
  }

  if (profile?.flags?.watched) {
    embed.addFields(field('⚠️ Watchlist', profile.flags.watchReason ?? 'Flagged by staff'));
  }

  embed.addFields(
    field(
      `Recent cases${totalCases > 10 ? ` (showing 10 of ${totalCases})` : ''}`,
      cases.length ? cases.map(caseLine).join('\n') : 'Clean record — no cases.',
    ),
  );

  if (tickets.length) {
    embed.addFields(
      field(
        'Recent tickets',
        tickets
          .map(
            (t) =>
              `\`#${padNumber(t.ticketId)}\` ${t.category} · ${
                t.status === TicketStatus.CLOSED ? 'closed' : 'open'
              }`,
          )
          .join('\n'),
      ),
    );
  }

  if (notes.length) {
    embed.addFields(
      field(
        'Staff notes',
        notes
          .map((n) => `${n.pinned ? '📌 ' : ''}**${n.authorTag}**: ${n.content.slice(0, 150)}`)
          .join('\n'),
      ),
    );
  }

  const activeBan = cases.find((c) => c.type === PunishmentType.BAN && c.active);
  if (activeBan) {
    embed.setFooter({
      text: `Currently banned — case #${padNumber(activeBan.caseId)}`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
