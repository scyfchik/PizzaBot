import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { User } from '../../database/models/User.js';
import { Ticket } from '../../database/models/Ticket.js';
import { Punishment } from '../../database/models/Punishment.js';
import { BugReport } from '../../database/models/BugReport.js';
import { RobloxProfile } from '../../database/models/RobloxProfile.js';
import { StaffNote } from '../../database/models/StaffNote.js';
import {
  Permission,
  Emojis,
  Colors,
  PunishmentType,
  TicketStatus,
  PurchaseStatus,
} from '../../config/constants.js';
import { caseLine } from '../../systems/moderation/caseEmbeds.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel, padNumber, truncate } from '../../utils/embeds.js';
import { fullTimestamp, timestamp, accountAgeDays, formatDuration } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Everything the studio knows about one person, in one command.
 *
 * This replaces the old `/profile`, `/history` and `/verify`. Those were three
 * commands answering one question — "who is this and what have they done" — and
 * splitting the answer across them meant staff ran all three every time.
 *
 * A player may be identified by Discord member **or** Roblox username, because
 * a purchase-support ticket usually arrives with only the latter.
 */
export const data = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Look up a player')
  .addSubcommand((sub) =>
    sub
      .setName('profile')
      .setDescription('Full player profile — Discord, Roblox, game stats, support history')
      .addUserOption((o) => o.setName('member').setDescription('Discord member'))
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username, if they are not in Discord'),
      )
      .addBooleanOption((o) =>
        o.setName('public').setDescription('Post visibly (default: only you)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('history')
      .setDescription('Moderation and support history')
      .addUserOption((o) => o.setName('member').setDescription('Discord member').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('economy')
      .setDescription('Spend summary for a player')
      .addUserOption((o) => o.setName('member').setDescription('Discord member'))
      .addStringOption((o) => o.setName('roblox').setDescription('Roblox username')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('purchases')
      .setDescription('Recent transactions, including failures')
      .addUserOption((o) => o.setName('member').setDescription('Discord member'))
      .addStringOption((o) => o.setName('roblox').setDescription('Roblox username'))
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many (default 10)').setMinValue(1).setMaxValue(25),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription('Link a Discord account to a Roblox username')
      .addStringOption((o) =>
        o
          .setName('roblox')
          .setDescription('Roblox username')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(20),
      )
      .addUserOption((o) =>
        o.setName('member').setDescription('Staff only — defaults to you'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unlink')
      .setDescription('Remove a Roblox link')
      .addUserOption((o) => o.setName('member').setDescription('Staff only — defaults to you')),
  );

export const meta = {
  // Looking yourself up is open; looking up others is gated per-subcommand.
  permission: null,
  cooldown: 4,
};

export async function execute(interaction, { client, staff }) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'profile':
      return profile(interaction, client, staff);
    case 'history':
      return history(interaction, staff);
    case 'economy':
      return economy(interaction, client, staff);
    case 'purchases':
      return purchases(interaction, client, staff);
    case 'link':
      return link(interaction, staff);
    case 'unlink':
      return unlink(interaction, staff);
  }
}

/**
 * Resolve the target from either option.
 * Returns `{ member, roblox, robloxId }` with whatever could be found.
 */
async function resolveTarget(interaction, client) {
  const member = interaction.options.getMember('member');
  const robloxName = interaction.options.getString('roblox');

  if (robloxName) {
    const profileDoc = await RobloxProfile.findOne({
      username: new RegExp(`^${robloxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).lean();

    const stats = await client
      .getSystem('gameData')
      .findByUsername(interaction.guildId, robloxName);

    return {
      member: profileDoc
        ? await interaction.guild.members.fetch(profileDoc.discordId).catch(() => null)
        : null,
      roblox: profileDoc ?? { username: robloxName, verified: false },
      robloxId: profileDoc?.robloxId ?? stats?.robloxId ?? null,
      stats,
    };
  }

  const target = member ?? interaction.member;
  const profileDoc = await RobloxProfile.findOne({ discordId: target.id }).lean();
  const robloxId = profileDoc?.robloxId ?? null;

  const stats = robloxId
    ? await client.getSystem('gameData').getStats(interaction.guildId, robloxId)
    : profileDoc?.username
      ? await client.getSystem('gameData').findByUsername(interaction.guildId, profileDoc.username)
      : null;

  return { member: target, roblox: profileDoc, robloxId: robloxId ?? stats?.robloxId ?? null, stats };
}

/** Viewing anyone but yourself needs the node. */
function guardOthers(interaction, staff, targetMember) {
  const isSelf = targetMember && targetMember.id === interaction.user.id;
  if (!isSelf && !hasPermission(staff, Permission.PLAYER_VIEW)) {
    throw new PermissionError('You can look yourself up, but not other players.');
  }
}

// ------------------------------------------------------------------ profile

async function profile(interaction, client, staff) {
  const isPublic = interaction.options.getBoolean('public') ?? false;
  await interaction.deferReply({ flags: isPublic ? undefined : MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);
  guardOthers(interaction, staff, target.member);

  if (!target.member && !target.roblox?.username && !target.stats) {
    throw new UserError('No player found by that name, and they are not in this server.');
  }

  const guildId = interaction.guildId;
  const canSeeEconomy = hasPermission(staff, Permission.PLAYER_ECONOMY);

  const [tickets, warnings, bans, bugs] = await Promise.all([
    target.member ? Ticket.countDocuments({ guildId, openerId: target.member.id }) : 0,
    target.member
      ? Punishment.countDocuments({
          guildId,
          userId: target.member.id,
          type: PunishmentType.WARN,
          active: true,
        })
      : 0,
    target.member
      ? Punishment.countDocuments({
          guildId,
          userId: target.member.id,
          type: PunishmentType.BAN,
          active: true,
        })
      : 0,
    target.member ? BugReport.countDocuments({ guildId, reporterId: target.member.id }) : 0,
  ]);

  const embed = new EmbedBuilder()
    .setColor(Colors.BRAND)
    .setTitle(`${Emojis.PIZZA} Player Profile`)
    .setTimestamp();

  if (target.member) {
    embed
      .setThumbnail(target.member.user.displayAvatarURL())
      .addFields(
        field('👤 Discord', `${target.member}\n\`${target.member.user.tag}\``, true),
        field(
          '📅 Joined server',
          target.member.joinedAt ? timestamp(target.member.joinedAt, 'R') : 'Unknown',
          true,
        ),
        field(
          '🗓️ Account age',
          `${accountAgeDays(target.member.user.createdAt)} days`,
          true,
        ),
      );
  } else {
    embed.addFields(field('👤 Discord', '*not linked to a Discord account*', true));
  }

  embed.addFields(field('🎮 Roblox', robloxBlock(target), true));

  // Game statistics, when the game has ever reported any.
  if (target.stats) {
    const a = target.stats.activity ?? {};
    const p = target.stats.progression ?? {};
    embed.addFields(
      field(
        '⏱️ In-game activity',
        `Playtime **${formatPlaytime(a.playtimeMinutes)}**\n` +
          `Sessions **${a.sessions ?? 0}** · Deaths **${a.deaths ?? 0}**\n` +
          `Last seen ${a.lastSeenAt ? timestamp(a.lastSeenAt, 'R') : 'never'}`,
        true,
      ),
      field('📈 Progression', `Level **${p.level ?? 0}**\nXP **${(p.xp ?? 0).toLocaleString()}**`, true),
    );

    if (canSeeEconomy) {
      const e = target.stats.economy ?? {};
      embed.addFields(
        field(
          '💳 Spend',
          `**R$ ${(e.robuxSpent ?? 0).toLocaleString()}** across **${e.purchaseCount ?? 0}** purchase(s)\n` +
            `${e.failedPurchaseCount ?? 0} failed · ${e.refundedCount ?? 0} refunded`,
          true,
        ),
      );
    }

    if (target.stats.flags?.bannedInGame) {
      embed.addFields(
        field(
          '🚫 Banned in-game',
          truncate(target.stats.flags.banReason ?? 'No reason recorded', 300),
        ),
      );
    }
  } else {
    embed.addFields(
      field(
        '⏱️ In-game activity',
        '*No game data.*\nYour game has not reported anything for this player — see `/game stats`.',
      ),
    );
  }

  embed.addFields(
    field(
      '🎫 Support',
      `Tickets **${tickets}** · Bugs reported **${bugs}**\n` +
        `Active warnings **${warnings}** · Active bans **${bans}**`,
    ),
  );

  if (isPublic) {
    embed.setFooter({ text: 'Posted publicly — moderation detail is hidden.' });
  }

  await interaction.editReply({ embeds: [embed] });
}

function robloxBlock(target) {
  if (!target.roblox?.username && !target.stats?.robloxUsername) return '*not linked*';

  const username = target.roblox?.username ?? target.stats?.robloxUsername;
  const verified = target.roblox?.verified;
  const id = target.robloxId;

  return (
    `\`${username}\`\n` +
    (id ? `ID \`${id}\`\n` : '') +
    (verified ? `${Emojis.CHECK} verified` : '⚠️ unverified')
  );
}

function formatPlaytime(minutes) {
  if (!minutes) return '0m';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  if (hours < 100) return `${hours}h ${minutes % 60}m`;
  return `${hours.toLocaleString()}h`;
}

// ------------------------------------------------------------------ history

async function history(interaction, staff) {
  if (!hasPermission(staff, Permission.MOD_HISTORY)) {
    throw new PermissionError('Player history is a staff tool.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('member');
  const guildId = interaction.guildId;

  const [cases, total, tickets, notes, profileDoc] = await Promise.all([
    Punishment.find({ guildId, userId: user.id }).sort({ createdAt: -1 }).limit(10).lean(),
    Punishment.countDocuments({ guildId, userId: user.id }),
    Ticket.find({ guildId, openerId: user.id }).sort({ createdAt: -1 }).limit(5).lean(),
    hasPermission(staff, Permission.STAFF_NOTES)
      ? StaffNote.find({ guildId, userId: user.id }).sort({ pinned: -1, createdAt: -1 }).limit(5).lean()
      : [],
    User.findOne({ guildId, discordId: user.id }).lean(),
  ]);

  const stats = profileDoc?.stats ?? {};

  const embed = embeds
    .brand(`History — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      field('User', userLabel(user), true),
      field(
        'Totals',
        `Warns **${stats.warns ?? 0}** · Timeouts **${stats.timeouts ?? 0}** · ` +
          `Kicks **${stats.kicks ?? 0}** · Bans **${stats.bans ?? 0}**`,
      ),
      field(
        `Cases${total > 10 ? ` (10 of ${total})` : ''}`,
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
        notes.map((n) => `${n.pinned ? '📌 ' : ''}**${n.authorTag}**: ${truncate(n.content, 150)}`).join('\n'),
      ),
    );
  }

  if (profileDoc?.flags?.watched) {
    embed.addFields(field('⚠️ Watchlist', profileDoc.flags.watchReason ?? 'Flagged by staff'));
  }

  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------------------------------------------ economy

async function economy(interaction, client, staff) {
  if (!hasPermission(staff, Permission.PLAYER_ECONOMY)) {
    throw new PermissionError('Economy data is restricted.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);
  if (!target.robloxId) throw new UserError(noGameDataMessage(target));

  const gameData = client.getSystem('gameData');
  const [summary, recent] = await Promise.all([
    gameData.economySummary(interaction.guildId, target.robloxId),
    gameData.purchases(interaction.guildId, target.robloxId, 1),
  ]);

  const last = recent[0];

  await interaction.editReply({
    embeds: [
      embeds
        .brand('💳 Economy History')
        .addFields(
          field('Player', target.roblox?.username ?? target.stats?.robloxUsername ?? target.robloxId, true),
          field('Robux spent', `**R$ ${summary.robuxSpent.toLocaleString()}**`, true),
          field('Purchases', String(summary.completed), true),
          field('Failed purchases', String(summary.failed), true),
          field('Refunded', `${summary.refunded} (R$ ${summary.robuxRefunded.toLocaleString()})`, true),
          field(
            'Last purchase',
            last
              ? `**${last.productName ?? last.productId ?? 'Unknown'}**\n${fullTimestamp(last.purchasedAt)}`
              : 'None recorded',
            true,
          ),
        )
        .setFooter({
          text:
            summary.failed > 0
              ? 'Failed purchases are the usual cause of purchase-support tickets.'
              : 'Reported by the game.',
        }),
    ],
  });
}

// ------------------------------------------------------------------ purchases

async function purchases(interaction, client, staff) {
  if (!hasPermission(staff, Permission.PLAYER_ECONOMY)) {
    throw new PermissionError('Purchase data is restricted.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);
  if (!target.robloxId) throw new UserError(noGameDataMessage(target));

  const limit = interaction.options.getInteger('limit') ?? 10;
  const rows = await client
    .getSystem('gameData')
    .purchases(interaction.guildId, target.robloxId, limit);

  if (!rows.length) throw new UserError('No transactions recorded for that player.');

  const icon = {
    [PurchaseStatus.COMPLETED]: '🟢',
    [PurchaseStatus.FAILED]: '🔴',
    [PurchaseStatus.REFUNDED]: '🔄',
    [PurchaseStatus.PENDING]: '⏳',
  };

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`💳 Transactions — ${target.roblox?.username ?? target.robloxId}`)
        .setDescription(
          rows
            .map(
              (p) =>
                `${icon[p.status] ?? '•'} **${p.productName ?? p.productId ?? 'Unknown product'}** — ` +
                `R$ ${(p.robuxAmount ?? 0).toLocaleString()}\n` +
                `└ ${timestamp(p.purchasedAt, 'f')} · \`${truncate(p.transactionId, 24)}\`` +
                (p.failureReason ? `\n└ ⚠️ ${truncate(p.failureReason, 100)}` : ''),
            )
            .join('\n\n'),
        )
        .setFooter({ text: `${rows.length} most recent` }),
    ],
  });
}

function noGameDataMessage(target) {
  return (
    `No Roblox ID for ${target.roblox?.username ?? 'that player'}. ` +
    'Either they have not linked an account (`/player link`), or your game has not reported them yet.'
  );
}

// ------------------------------------------------------------------ linking

async function link(interaction, staff) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const requested = interaction.options.getMember('member');
  const isSelf = !requested || requested.id === interaction.user.id;

  if (!isSelf && !hasPermission(staff, Permission.PLAYER_LINK_MANAGE)) {
    throw new PermissionError("You can link your own account, but not someone else's.");
  }

  const member = requested ?? interaction.member;
  const username = interaction.options.getString('roblox').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new UserError('Roblox usernames are 3–20 characters: letters, numbers and underscores.');
  }

  const existing = await RobloxProfile.findOne({ discordId: member.id });
  if (existing?.verified && isSelf) {
    throw new UserError(
      `Your account is already verified as **${existing.username}**. Ask staff to unlink it first.`,
    );
  }

  await RobloxProfile.findOneAndUpdate(
    { discordId: member.id },
    {
      $set: {
        username,
        // Staff linking someone counts as a vouch; self-linking does not.
        verified: !isSelf,
        verifiedAt: !isSelf ? new Date() : null,
        verificationMethod: !isSelf ? 'manual' : null,
        verifiedBy: !isSelf ? interaction.user.id : null,
      },
      $setOnInsert: { discordId: member.id },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  await interaction.editReply({
    embeds: [
      embeds
        .success(`${member} linked to Roblox **${username}**.`)
        .addFields(
          field(
            'Status',
            isSelf
              ? '⚠️ **Unverified** — this is a self-reported name. Staff can confirm it by running the same command with `member:` set.'
              : `${Emojis.CHECK} **Verified** by ${interaction.user} — a manual vouch, not an API check.`,
          ),
        ),
    ],
  });
}

async function unlink(interaction, staff) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const requested = interaction.options.getMember('member');
  const isSelf = !requested || requested.id === interaction.user.id;

  if (!isSelf && !hasPermission(staff, Permission.PLAYER_LINK_MANAGE)) {
    throw new PermissionError("You can unlink your own account, but not someone else's.");
  }

  const member = requested ?? interaction.member;
  const existing = await RobloxProfile.findOne({ discordId: member.id });
  if (!existing) throw new UserError('No Roblox link on record.');

  await RobloxProfile.deleteOne({ discordId: member.id });

  await interaction.editReply({
    embeds: [embeds.success(`Unlinked **${existing.username ?? 'unknown'}** from ${member}.`)],
  });
}
