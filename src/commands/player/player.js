import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { User } from '../../database/models/User.js';
import { Ticket } from '../../database/models/Ticket.js';
import { Punishment } from '../../database/models/Punishment.js';
import { BugReport } from '../../database/models/BugReport.js';
import { StaffNote } from '../../database/models/StaffNote.js';
import {
  Permission,
  Emojis,
  Colors,
  PunishmentType,
  TicketStatus,
  PurchaseStatus,
  ProductType,
  ProductTypeLabel,
} from '../../config/constants.js';
import { caseLine } from '../../systems/moderation/caseEmbeds.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, userLabel, padNumber, truncate } from '../../utils/embeds.js';
import { fullTimestamp, timestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Everything the studio knows about one player, in one command.
 *
 * ## How a Discord member is matched to a Roblox account
 *
 * It is not verified, and Pizza Bot does not try to — Rover/Bloxlink own that.
 * A Discord member's Roblox account is **the username they last gave in a
 * ticket**, labelled as such wherever it is shown. Nothing is guessed from a
 * nickname: a Discord user called "builderman" is not Roblox's builderman, and
 * showing the wrong person's bans or purchases in a moderation decision is worse
 * than showing nothing.
 *
 * Looking up by `roblox:` goes straight to the Roblox API and needs no Discord
 * account at all — which is how purchase-support tickets usually arrive.
 */
export const data = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Look up a player')
  .addSubcommand((sub) =>
    sub
      .setName('profile')
      .setDescription('Roblox account, game stats and support history')
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username or user ID').setMaxLength(20),
      )
      .addUserOption((o) => o.setName('member').setDescription('Discord member'))
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
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username or user ID').setMaxLength(20),
      )
      .addUserOption((o) => o.setName('member').setDescription('Discord member')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('purchases')
      .setDescription('What they bought — and what was granted or failed')
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username or user ID').setMaxLength(20),
      )
      .addUserOption((o) => o.setName('member').setDescription('Discord member'))
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Only one kind of product')
          .addChoices(
            ...Object.values(ProductType).map((value) => ({
              name: ProductTypeLabel[value].replace(/^\S+\s/, ''),
              value,
            })),
          ),
      )
      .addBooleanOption((o) => o.setName('failed-only').setDescription('Only purchases that were NOT granted'))
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many (default 10)').setMinValue(1).setMaxValue(25),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('stats')
      .setDescription('Kills, deaths, K/D, playtime and progression')
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username or user ID').setMaxLength(20),
      )
      .addUserOption((o) => o.setName('member').setDescription('Discord member')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('anticheat')
      .setDescription('Anticheat flags — evidence for appeals')
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username or user ID').setMaxLength(20),
      )
      .addUserOption((o) => o.setName('member').setDescription('Discord member'))
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many flags (default 10)').setMinValue(1).setMaxValue(25),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('gamepasses')
      .setDescription('Which of our game passes they own, according to Roblox')
      .addStringOption((o) =>
        o.setName('roblox').setDescription('Roblox username or user ID').setMaxLength(20),
      )
      .addUserOption((o) => o.setName('member').setDescription('Discord member')),
  );

export const meta = {
  // Looking yourself up is open; everything else is gated per subcommand.
  permission: null,
  cooldown: 4,
};

export async function execute(interaction, { client, staff }) {
  switch (interaction.options.getSubcommand()) {
    case 'profile':
      return profile(interaction, client, staff);
    case 'history':
      return history(interaction, staff);
    case 'economy':
      return economy(interaction, client, staff);
    case 'purchases':
      return purchases(interaction, client, staff);
    case 'stats':
      return stats(interaction, client, staff);
    case 'anticheat':
      return anticheat(interaction, client, staff);
    case 'gamepasses':
      return gamepasses(interaction, client, staff);
  }
}

// ------------------------------------------------------------------ resolution

/**
 * Work out who is being looked up.
 *
 * @returns {Promise<{
 *   member: import('discord.js').GuildMember|null,
 *   robloxName: string|null,
 *   robloxSource: 'roblox'|'ticket'|null,
 *   sourceTicketId: number|null,
 *   roblox: object|null,
 *   robloxUnavailable: boolean,
 *   stats: object|null,
 * }>}
 */
async function resolveTarget(interaction, client) {
  const guildId = interaction.guildId;
  const robloxInput = interaction.options.getString('roblox')?.trim() || null;
  const players = client.getSystem('roblox').players;
  const gameData = client.getSystem('gameData');

  let member = null;
  let robloxName = null;
  let robloxSource = null;
  let sourceTicketId = null;

  if (robloxInput) {
    robloxName = robloxInput;
    robloxSource = 'roblox';
  } else {
    member = interaction.options.getMember('member') ?? interaction.member;

    // The last Roblox username this member gave us in a ticket.
    const ticket = await Ticket.findOne({
      guildId,
      openerId: member.id,
      robloxUsername: { $ne: null },
    })
      .sort({ createdAt: -1 })
      .select({ robloxUsername: 1, ticketId: 1 })
      .lean();

    if (ticket?.robloxUsername) {
      robloxName = ticket.robloxUsername;
      robloxSource = 'ticket';
      sourceTicketId = ticket.ticketId;
    }
  }

  const { profile: roblox, unavailable } = robloxName
    ? await players.tryGetProfile(robloxName)
    : { profile: null, unavailable: false };

  // Game data is keyed by Roblox id. Fall back to the stored username when the
  // Roblox API is down, so an outage does not hide data we already have.
  const stats = roblox
    ? await gameData.getStats(guildId, roblox.id)
    : robloxName && !/^\d+$/.test(robloxName)
      ? await gameData.findByUsername(guildId, robloxName)
      : null;

  return { member, robloxName, robloxSource, sourceTicketId, roblox, robloxUnavailable: unavailable, stats };
}

/**
 * Looking up anyone but yourself needs `player.view`. A `roblox:` lookup always
 * counts as "someone else": without verification, nobody can prove a Roblox
 * account is theirs.
 */
function guardAccess(interaction, staff) {
  const isRobloxLookup = Boolean(interaction.options.getString('roblox'));
  const member = interaction.options.getMember('member');
  const isSelf = !isRobloxLookup && (!member || member.id === interaction.user.id);

  if (!isSelf && !hasPermission(staff, Permission.PLAYER_VIEW)) {
    throw new PermissionError('You can look yourself up, but not other players.');
  }
}

// ------------------------------------------------------------------ profile

async function profile(interaction, client, staff) {
  guardAccess(interaction, staff);

  const isPublic = interaction.options.getBoolean('public') ?? false;
  await interaction.deferReply({ flags: isPublic ? undefined : MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);

  if (target.robloxSource === 'roblox' && !target.roblox && !target.robloxUnavailable) {
    throw new UserError(`No Roblox account called **${target.robloxName}** exists.`);
  }

  const guildId = interaction.guildId;
  const canSeeEconomy = hasPermission(staff, Permission.PLAYER_ECONOMY) && !isPublic;

  // Discord members who used this Roblox name in a ticket — shown when the
  // lookup started from Roblox, so staff can see who has claimed the account.
  const claimants =
    target.robloxSource === 'roblox' && target.roblox && !isPublic
      ? await Ticket.distinct('openerId', {
          guildId,
          robloxUsername: new RegExp(`^${escapeRegex(target.roblox.name)}$`, 'i'),
        })
      : [];

  const memberId = target.member?.id ?? null;
  const [tickets, warnings, bans, bugs] = memberId
    ? await Promise.all([
        Ticket.countDocuments({ guildId, openerId: memberId }),
        Punishment.countDocuments({ guildId, userId: memberId, type: PunishmentType.WARN, active: true }),
        Punishment.countDocuments({ guildId, userId: memberId, type: PunishmentType.BAN, active: true }),
        BugReport.countDocuments({ guildId, reporterId: memberId }),
      ])
    : [0, 0, 0, 0];

  const embed = new EmbedBuilder()
    .setColor(target.roblox?.isBanned ? Colors.DANGER : Colors.BRAND)
    .setTitle(`${Emojis.PIZZA} Player Profile`)
    .setTimestamp();

  // ----- Roblox (from the Roblox API)
  if (target.roblox) {
    const r = target.roblox;
    embed.setURL(r.profileUrl);
    if (r.headshotUrl) embed.setThumbnail(r.headshotUrl);

    const nameLine =
      r.displayName && r.displayName !== r.name
        ? `**${r.displayName}** (@${r.name})`
        : `**${r.name}**`;

    embed.addFields(
      field(
        '🎮 Roblox',
        `${nameLine}${r.hasVerifiedBadge ? ' ☑️' : ''}\nID \`${r.id}\`\n[Open profile](${r.profileUrl})`,
        true,
      ),
      field(
        '🗓️ Account',
        r.created
          ? `Created ${timestamp(r.created, 'D')}\n**${r.accountAgeDays.toLocaleString()} days** old`
          : 'Creation date unknown',
        true,
      ),
    );

    if (r.groupRole) {
      embed.addFields(field('🏷️ Studio group', `${r.groupRole.name} (rank ${r.groupRole.rank})`, true));
    }

    if (r.isBanned) {
      embed.addFields(field('🚫 Banned by Roblox', 'This account is terminated on the Roblox platform.'));
    }

    if (r.previousNames.length && !isPublic) {
      embed.addFields(field('📜 Previous usernames', r.previousNames.slice(0, 8).join(', ')));
    }

    if (target.robloxSource === 'ticket') {
      embed.addFields(
        field(
          'ℹ️ Source',
          `Roblox account taken from ticket \`#${padNumber(target.sourceTicketId)}\` — self-reported, not verified.`,
        ),
      );
    }

    if (r.partial) embed.setFooter({ text: 'Some Roblox details could not be loaded.' });
  } else if (target.robloxUnavailable) {
    embed.addFields(
      field(
        '🎮 Roblox',
        `\`${target.robloxName}\`\n⚠️ Roblox API unavailable right now — showing stored data only.`,
        true,
      ),
    );
  } else {
    embed.addFields(
      field(
        '🎮 Roblox',
        '*No Roblox account known.*\nThey have not given one in a ticket — try `/player profile roblox:<name>`.',
        true,
      ),
    );
  }

  // ----- Discord
  if (target.member) {
    if (!target.roblox?.headshotUrl) embed.setThumbnail(target.member.user.displayAvatarURL());
    embed.addFields(
      field(
        '👤 Discord',
        `${target.member}\nJoined ${target.member.joinedAt ? timestamp(target.member.joinedAt, 'R') : 'unknown'}`,
        true,
      ),
    );
  } else if (claimants.length) {
    embed.addFields(
      field(
        '👤 Claimed in tickets by',
        claimants.slice(0, 5).map((id) => `<@${id}>`).join(', ') +
          (claimants.length > 1 ? '\n⚠️ More than one Discord account used this name.' : ''),
        true,
      ),
    );
  }

  // ----- In-game (reported by the game)
  if (target.stats) {
    const a = target.stats.activity ?? {};
    const p = target.stats.progression ?? {};
    const c = target.stats.combat ?? {};
    const ac = target.stats.anticheat ?? {};
    embed.addFields(
      field(
        '⏱️ In-game',
        `Playtime **${formatPlaytime(a.playtimeMinutes)}** · Level **${p.level ?? 0}**\n` +
          `Kills **${c.kills ?? 0}** · Deaths **${c.deaths ?? 0}** · K/D **${kdRatio(c.kills, c.deaths)}**\n` +
          `Sessions **${a.sessions ?? 0}** · Last seen ${a.lastSeenAt ? timestamp(a.lastSeenAt, 'R') : 'never'}`,
      ),
    );

    if (ac.flags && !isPublic) {
      embed.addFields(
        field(
          '🛡️ Anticheat',
          `**${ac.flags}** flag(s)${ac.highSeverity ? ` · **${ac.highSeverity} high**` : ''} · last \`${ac.lastCheck ?? '?'}\` ${ac.lastFlagAt ? timestamp(ac.lastFlagAt, 'R') : ''}\nDetails: \`/player anticheat\``,
        ),
      );
    }

    if (canSeeEconomy) {
      const e = target.stats.economy ?? {};
      embed.addFields(
        field(
          '💳 Spend',
          `**R$ ${(e.robuxSpent ?? 0).toLocaleString()}** · ${e.purchaseCount ?? 0} purchase(s)` +
            `${e.failedPurchaseCount ? ` · **${e.failedPurchaseCount} failed**` : ''}`,
        ),
      );
    }

    if (target.stats.flags?.bannedInGame) {
      embed.addFields(
        field('🚫 Banned in-game', truncate(target.stats.flags.banReason ?? 'No reason recorded', 300)),
      );
    }
  } else if (target.roblox) {
    embed.addFields(field('⏱️ In-game', '*No game data reported for this player yet.*'));
  }

  // ----- Support
  if (target.member) {
    embed.addFields(
      field(
        '🎫 Support',
        `Tickets **${tickets}** · Bugs reported **${bugs}**` +
          (isPublic ? '' : `\nActive warnings **${warnings}** · Active bans **${bans}**`),
      ),
    );
  }

  if (isPublic) embed.setFooter({ text: 'Posted publicly — moderation and spend detail hidden.' });

  await interaction.editReply({ embeds: [embed] });
}

function formatPlaytime(minutes) {
  if (!minutes) return '0m';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  if (hours < 100) return `${hours}h ${minutes % 60}m`;
  return `${hours.toLocaleString()}h`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
              }${t.robloxUsername ? ` · Roblox \`${t.robloxUsername}\`` : ''}`,
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
  const robloxId = target.roblox?.id ?? target.stats?.robloxId ?? null;
  if (!robloxId) throw new UserError(noRobloxMessage(target));

  const gameData = client.getSystem('gameData');
  const [summary, recent] = await Promise.all([
    gameData.economySummary(interaction.guildId, robloxId),
    gameData.purchases(interaction.guildId, robloxId, 1),
  ]);

  const last = recent[0];
  const embed = embeds
    .brand('💳 Economy History')
    .addFields(
      field('Player', displayName(target, robloxId), true),
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
    });

  if (target.roblox?.headshotUrl) embed.setThumbnail(target.roblox.headshotUrl);
  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------------------------------------------ purchases

async function purchases(interaction, client, staff) {
  if (!hasPermission(staff, Permission.PLAYER_ECONOMY)) {
    throw new PermissionError('Purchase data is restricted.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);
  const robloxId = target.roblox?.id ?? target.stats?.robloxId ?? null;
  if (!robloxId) throw new UserError(noRobloxMessage(target));

  const gameData = client.getSystem('gameData');
  const limit = interaction.options.getInteger('limit') ?? 10;
  const productType = interaction.options.getString('type');
  const failedOnly = interaction.options.getBoolean('failed-only') ?? false;

  const [rows, breakdown] = await Promise.all([
    gameData.purchases(interaction.guildId, robloxId, limit, {
      productType,
      status: failedOnly ? PurchaseStatus.FAILED : null,
    }),
    gameData.purchaseBreakdown(interaction.guildId, robloxId),
  ]);

  if (!Object.keys(breakdown).length) {
    throw new UserError(
      'No purchases reported for that player. For game passes, `/player gamepasses` asks Roblox directly.',
    );
  }

  const embed = embeds.brand(`💳 Purchases — ${displayName(target, robloxId)}`);
  if (target.roblox?.headshotUrl) embed.setThumbnail(target.roblox.headshotUrl);

  // Summary per product type: granted vs not granted. The "not granted" count
  // is what a purchase-support ticket is almost always about.
  embed.addFields(
    ...Object.entries(breakdown).map(([type, b]) =>
      field(
        ProductTypeLabel[type] ?? type,
        `✅ Granted **${b.granted}**` +
          (b.failed ? ` · ❌ **Not granted ${b.failed}**` : '') +
          (b.refunded ? ` · 🔄 Refunded ${b.refunded}` : '') +
          `\nR$ ${b.robux.toLocaleString()}`,
        true,
      ),
    ),
  );

  const icon = {
    [PurchaseStatus.COMPLETED]: '✅',
    [PurchaseStatus.FAILED]: '❌',
    [PurchaseStatus.REFUNDED]: '🔄',
    [PurchaseStatus.PENDING]: '⏳',
  };

  embed.addFields(
    field(
      failedOnly ? 'Not granted' : productType ? `Recent — ${ProductTypeLabel[productType]}` : 'Recent',
      rows.length
        ? rows
            .map(
              (p) =>
                `${icon[p.status] ?? '•'} **${truncate(p.productName ?? p.productId ?? 'Unknown', 40)}** · ` +
                `R$ ${(p.robuxAmount ?? 0).toLocaleString()} · ${timestamp(p.purchasedAt, 'd')}` +
                (p.failureReason ? `\n└ ⚠️ ${truncate(p.failureReason, 80)}` : ''),
            )
            .join('\n')
        : 'Nothing matches that filter.',
    ),
  );

  embed.setFooter({ text: '✅ = item was granted in-game · ❌ = payment recorded but item not granted' });
  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------------------------------------------ stats

/** K/D with a sensible zero-deaths case: 12 kills and 0 deaths is 12.00, not ∞. */
export function kdRatio(kills, deaths) {
  const k = kills ?? 0;
  const d = deaths ?? 0;
  return (d === 0 ? k : k / d).toFixed(2);
}

async function stats(interaction, client, staff) {
  guardAccess(interaction, staff);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);
  if (!target.stats) {
    throw new UserError(
      target.roblox
        ? `Your game has not reported anything for **${target.roblox.name}** yet.`
        : noRobloxMessage(target),
    );
  }

  const s = target.stats;
  const c = s.combat ?? {};
  const a = s.activity ?? {};
  const p = s.progression ?? {};
  const ac = s.anticheat ?? {};

  const embed = embeds
    .brand(`📊 Player stats — ${displayName(target, s.robloxId)}`)
    .addFields(
      field('⚔️ Kills', (c.kills ?? 0).toLocaleString(), true),
      field('💀 Deaths', (c.deaths ?? 0).toLocaleString(), true),
      field('📈 K/D', kdRatio(c.kills, c.deaths), true),
      field('⏱️ Playtime', formatPlaytime(a.playtimeMinutes), true),
      field('🎮 Sessions', String(a.sessions ?? 0), true),
      field('⭐ Level', `${p.level ?? 0} · ${(p.xp ?? 0).toLocaleString()} XP`, true),
      field('🕒 First seen', a.firstSeenAt ? timestamp(a.firstSeenAt, 'D') : '—', true),
      field('👀 Last seen', a.lastSeenAt ? timestamp(a.lastSeenAt, 'R') : '—', true),
      field(
        '🛡️ Anticheat',
        ac.flags ? `**${ac.flags}** flag(s)${ac.highSeverity ? ` · ${ac.highSeverity} high` : ''}` : 'Clean',
        true,
      ),
    );

  if (target.roblox?.headshotUrl) embed.setThumbnail(target.roblox.headshotUrl);
  if (ac.flags) embed.setFooter({ text: 'Details: /player anticheat' });

  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------------------------------------------ anticheat

async function anticheat(interaction, client, staff) {
  if (!hasPermission(staff, Permission.PLAYER_VIEW)) {
    throw new PermissionError('Anticheat history is a staff tool.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = await resolveTarget(interaction, client);
  const robloxId = target.roblox?.id ?? target.stats?.robloxId ?? null;
  if (!robloxId) throw new UserError(noRobloxMessage(target));

  const limit = interaction.options.getInteger('limit') ?? 10;
  const flags = await client.getSystem('gameData').anticheatFlags(interaction.guildId, robloxId, limit);
  const ac = target.stats?.anticheat ?? {};

  const embed = embeds.brand(`🛡️ Anticheat — ${displayName(target, robloxId)}`);
  if (target.roblox?.headshotUrl) embed.setThumbnail(target.roblox.headshotUrl);

  if (!ac.flags && !flags.length) {
    embed.setDescription('✅ No anticheat flags on record.');
    return interaction.editReply({ embeds: [embed] });
  }

  const byCheck = Object.entries(ac.byCheck ?? {}).sort((x, y) => y[1] - x[1]);
  const sevIcon = { high: '🔴', medium: '🟠', low: '🟡' };

  embed.addFields(
    field('Total flags', String(ac.flags ?? flags.length), true),
    field('High severity', String(ac.highSeverity ?? 0), true),
    field(
      'Period',
      ac.firstFlagAt ? `${timestamp(ac.firstFlagAt, 'd')} → ${timestamp(ac.lastFlagAt, 'd')}` : '—',
      true,
    ),
  );

  if (byCheck.length) {
    embed.addFields(
      field('By check', byCheck.slice(0, 10).map(([k, n]) => `\`${k}\` × **${n}**`).join('\n')),
    );
  }

  embed.addFields(
    field(
      `Latest ${flags.length}`,
      flags.length
        ? flags
            .map((f) => {
              const d = f.data ?? {};
              return (
                `${sevIcon[d.severity] ?? '🟡'} \`${truncate(d.check ?? 'unknown', 30)}\` · ${timestamp(f.occurredAt, 'f')}` +
                (d.action ? ` · **${truncate(String(d.action), 20)}**` : '') +
                (d.details ? `\n└ ${truncate(typeof d.details === 'string' ? d.details : JSON.stringify(d.details), 90)}` : '')
              );
            })
            .join('\n')
        : 'Individual flags have expired (kept 365 days); totals above remain.',
    ),
  );

  embed.setFooter({ text: 'Reported by the game’s anticheat. A flag is a signal, not proof — check the details.' });
  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------------------------------------------ gamepasses

async function gamepasses(interaction, client, staff) {
  if (!hasPermission(staff, Permission.PLAYER_ECONOMY)) {
    throw new PermissionError('Purchase data is restricted.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const passes = client.getSystem('roblox').gamePasses;
  if (!passes.configured) {
    throw new UserError('Set `ROBLOX_UNIVERSE_ID` in .env to check game pass ownership.');
  }

  const target = await resolveTarget(interaction, client);
  const robloxId = target.roblox?.id ?? null;
  if (!robloxId) {
    throw new UserError(
      target.robloxUnavailable ? 'Roblox API is unavailable right now.' : noRobloxMessage(target),
    );
  }

  let ownership;
  try {
    ownership = await passes.ownership(robloxId);
  } catch {
    throw new UserError('Roblox API is unavailable right now — try again in a minute.');
  }
  if (!ownership.length) throw new UserError('This experience has no game passes.');

  // What the game *recorded* granting, to compare against what Roblox says is owned.
  const recorded = await client
    .getSystem('gameData')
    .purchases(interaction.guildId, robloxId, 200, { productType: ProductType.GAMEPASS });
  const recordedIds = new Set(recorded.map((p) => String(p.productId)));

  const owned = ownership.filter((p) => p.owned === true);
  const lines = ownership.map((p) => {
    const mark = p.owned === true ? '✅' : p.owned === false ? '▫️' : '❔';
    // Owned on Roblox but the game never reported granting it: the classic
    // "I bought it and didn't get it" case, surfaced automatically.
    const mismatch = p.owned === true && recorded.length > 0 && !recordedIds.has(p.id) ? ' ⚠️ *not recorded as granted*' : '';
    return `${mark} ${truncate(p.name, 40)}${p.price != null ? ` · R$ ${p.price}` : ''}${mismatch}`;
  });

  const embed = embeds
    .brand(`🎟️ Game passes — ${displayName(target, robloxId)}`)
    .setDescription(truncate(lines.join('\n'), 4000))
    .addFields(field('Owns', `${owned.length} of ${ownership.length}`, true))
    .setFooter({
      text:
        '✅ owned per Roblox · ▫️ not owned · ❔ Roblox did not answer. ' +
        (recorded.length ? '⚠️ = owned but the game never reported granting it.' : 'The game has not reported any pass grants yet.'),
    });

  if (target.roblox?.headshotUrl) embed.setThumbnail(target.roblox.headshotUrl);
  await interaction.editReply({ embeds: [embed] });
}

function displayName(target, robloxId) {
  return target.roblox?.name ?? target.stats?.robloxUsername ?? target.robloxName ?? robloxId;
}

function noRobloxMessage(target) {
  if (target.robloxSource === 'roblox') {
    return `No Roblox account called **${target.robloxName}** exists.`;
  }
  return (
    'No Roblox account known for that member — they have not given one in a ticket. ' +
    'Use `roblox:<username>` instead.'
  );
}
