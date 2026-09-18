import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { User } from '../../database/models/User.js';
import { Ticket } from '../../database/models/Ticket.js';
import { Punishment } from '../../database/models/Punishment.js';
import { BugReport } from '../../database/models/BugReport.js';
import { RobloxProfile } from '../../database/models/RobloxProfile.js';
import { Emojis, PunishmentType, Permission } from '../../config/constants.js';
import { resolveStaff, rankLabel, hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel } from '../../utils/embeds.js';
import { fullTimestamp, accountAgeDays } from '../../utils/time.js';
import { UserError } from '../../core/errors.js';

/**
 * Player profile — the public-facing view.
 *
 * Deliberately *not* `/history`. That command is a moderation tool showing case
 * reasons, staff notes and voided punishments; this one shows counts only, so a
 * player can run it on themselves without the bot publishing someone's
 * disciplinary record into a channel.
 *
 * Counts come from indexed `countDocuments` calls rather than loading the
 * documents. Five counts on indexed fields is cheap; fetching five collections
 * of documents to call `.length` is not.
 */
export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('Show a player profile')
  .addUserOption((o) => o.setName('member').setDescription('Defaults to you'))
  .addBooleanOption((o) =>
    o.setName('public').setDescription('Post visibly in the channel (default: only you)'),
  );

export const meta = {
  permission: null, // anyone can look up a profile
  cooldown: 5,
};

export async function execute(interaction, { staff }) {
  const isPublic = interaction.options.getBoolean('public') ?? false;
  await interaction.deferReply({ flags: isPublic ? undefined : MessageFlags.Ephemeral });

  const member = interaction.options.getMember('member') ?? interaction.member;
  if (!member) throw new UserError('That member is not in the server.');

  const guildId = interaction.guildId;
  const userId = member.id;

  const [profile, roblox, tickets, warnings, bugsFiled, bugsFixed, targetStaff] = await Promise.all([
    User.findOne({ guildId, discordId: userId }).lean(),
    RobloxProfile.findOne({ discordId: userId }).lean(),
    Ticket.countDocuments({ guildId, openerId: userId }),
    Punishment.countDocuments({ guildId, userId, type: PunishmentType.WARN, active: true }),
    BugReport.countDocuments({ guildId, reporterId: userId }),
    BugReport.countDocuments({ guildId, reporterId: userId, status: 'FIXED' }),
    resolveStaff(member),
  ]);

  const embed = embeds
    .brand(`${Emojis.PIZZA} Player Profile`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      field('👤 Discord', userLabel(member.user), true),
      field('🎮 Roblox', robloxLine(roblox), true),
      field('🏅 Rank', rankLabel(targetStaff), true),
      field('🎫 Tickets opened', String(tickets), true),
      field('⚠️ Active warnings', String(warnings), true),
      field('🐛 Bugs reported', bugsFiled ? `${bugsFiled} (${bugsFixed} fixed)` : '0', true),
      field(
        '📅 Joined',
        member.joinedAt ? fullTimestamp(member.joinedAt) : 'Unknown',
        true,
      ),
      field(
        '🗓️ Account created',
        `${fullTimestamp(member.user.createdAt).split(' (')[0]}\n${accountAgeDays(member.user.createdAt)} days old`,
        true,
      ),
    );

  if (profile?.firstSeenAt) {
    embed.addFields(field('👀 First seen by the bot', fullTimestamp(profile.firstSeenAt), true));
  }

  // Watchlist status is staff-only — showing it publicly would tell the person
  // they are being watched, which defeats the purpose.
  if (profile?.flags?.watched && hasPermission(staff, Permission.STAFF_INFO) && !isPublic) {
    embed.addFields(
      field(`${Emojis.ALERT} Watchlist`, profile.flags.watchReason ?? 'Flagged by staff'),
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

function robloxLine(roblox) {
  if (!roblox?.username) return '*not linked*';
  return roblox.verified
    ? `\`${roblox.username}\` ${Emojis.CHECK}`
    : `\`${roblox.username}\`\n*unverified*`;
}
