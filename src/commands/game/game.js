import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Permission, GameEventType, Emojis } from '../../config/constants.js';
import { hasPermission } from '../../systems/staff/permissions.js';
import { embeds, field, truncate } from '../../utils/embeds.js';
import { timestamp } from '../../utils/time.js';
import { UserError, PermissionError } from '../../core/errors.js';

/**
 * Live game data.
 *
 * Every number here was reported by the game through the ingest endpoint. When
 * nothing has been reported, the commands say so plainly rather than showing a
 * wall of confident zeroes — a dashboard that looks healthy when it is actually
 * disconnected is worse than no dashboard.
 */
export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Live game statistics and events')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) => sub.setName('stats').setDescription('Server and player statistics'))
  .addSubcommand((sub) =>
    sub
      .setName('events')
      .setDescription('Recent events reported by the game')
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Filter by event type')
          .addChoices(
            ...Object.values(GameEventType)
              .slice(0, 25)
              .map((v) => ({ name: v, value: v })),
          ),
      )
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many (default 15)').setMinValue(1).setMaxValue(25),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('connection').setDescription('Is the game connected to the bot?'),
  );

export const meta = {
  permission: Permission.GAME_STATS,
  cooldown: 5,
};

export async function execute(interaction, { client, staff }) {
  const sub = interaction.options.getSubcommand();
  const gameData = client.getSystem('gameData');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'connection') return connection(interaction, client, gameData);
  if (sub === 'events') return events(interaction, gameData, staff);
  return stats(interaction, gameData, client);
}

/**
 * Two sources, shown side by side when both exist:
 *
 *   - **Roblox** (public API, needs only ROBLOX_UNIVERSE_ID): players online,
 *     visits, favourites, likes. Works from day one with no game changes.
 *   - **Your game** (ingest): per-player playtime, spend, failed purchases.
 *     Only once the in-game reporter is installed.
 *
 * Roblox's player count is authoritative; the ingest count is an upper bound,
 * because a crashed server never reports its leaves.
 */
async function stats(interaction, gameData, client) {
  const robloxGame = client.getSystem('roblox').game;

  const [ingest, live] = await Promise.all([
    gameData.serverStats(interaction.guildId),
    robloxGame.configured
      ? robloxGame.getStats().then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        )
      : Promise.resolve({ value: null, error: null }),
  ]);

  if (ingest.empty && !live.value) {
    throw new UserError(
      live.error
        ? 'Roblox API is unavailable right now, and your game has not reported any data yet.'
        : notConnected(robloxGame.configured),
    );
  }

  const embed = embeds.brand(`${Emojis.PIZZA} ${live.value?.name ?? 'Game Statistics'}`);

  if (live.value) {
    const g = live.value;
    embed.setURL(g.url).addFields(
      field('🟢 Playing now', g.playing.toLocaleString(), true),
      field('👣 Visits', g.visits.toLocaleString(), true),
      field('⭐ Favourites', g.favorites.toLocaleString(), true),
      field(
        '👍 Rating',
        g.likeRatio != null
          ? `${Math.round(g.likeRatio * 100)}% (${g.upVotes.toLocaleString()} 👍 · ${g.downVotes.toLocaleString()} 👎)`
          : '—',
        true,
      ),
      field('🧑‍🤝‍🧑 Server size', `${g.maxPlayers} max`, true),
      field('🛠️ Last updated', g.updated ? timestamp(g.updated, 'R') : '—', true),
    );
  } else if (live.error) {
    embed.addFields(field('🟢 Roblox', '⚠️ Roblox API unavailable — live numbers missing.'));
  }

  if (!ingest.empty) {
    const hours = Math.round(ingest.totalPlaytimeMinutes / 60);
    embed.addFields(
      field('​', '**From your game**'),
      field('🖥️ Active servers', String(ingest.servers), true),
      field('📅 Active today', String(ingest.activeToday), true),
      field('👥 Known players', ingest.totalPlayers.toLocaleString(), true),
      field('⏱️ Total playtime', `${hours.toLocaleString()}h`, true),
      field('💳 Lifetime spend', `R$ ${ingest.totalRobux.toLocaleString()}`, true),
      field(
        '💸 Today',
        `${ingest.purchasesToday} purchase(s)` +
          (ingest.failuresToday ? ` · **${ingest.failuresToday} failed**` : ' · 0 failed'),
        true,
      ),
    );
  } else {
    embed.addFields(
      field(
        '​',
        '*Per-player data (playtime, spend) appears once the in-game reporter is installed — see `/game connection`.*',
      ),
    );
  }

  embed.setFooter({
    text:
      ingest.failuresToday > 0
        ? 'Failed purchases today — expect purchase-support tickets.'
        : live.value
          ? 'Live numbers from Roblox, cached for one minute.'
          : 'Online count is an upper bound: a crashed server never reports its leaves.',
  });

  await interaction.editReply({ embeds: [embed] });
}

async function events(interaction, gameData, staff) {
  if (!hasPermission(staff, Permission.GAME_EVENTS)) {
    throw new PermissionError('Reading the raw event feed needs `game.events`.');
  }

  const rows = await gameData.recentEvents(interaction.guildId, {
    type: interaction.options.getString('type'),
    limit: interaction.options.getInteger('limit') ?? 15,
  });

  if (!rows.length) throw new UserError('No matching events. ' + notConnected());

  await interaction.editReply({
    embeds: [
      embeds
        .brand('🎮 Recent game events')
        .setDescription(
          rows
            .map(
              (e) =>
                `\`${e.type}\` ${e.robloxUsername ?? e.robloxId ?? ''} · ${timestamp(e.occurredAt, 'R')}` +
                (Object.keys(e.data ?? {}).length
                  ? `\n└ ${truncate(JSON.stringify(e.data), 120)}`
                  : ''),
            )
            .join('\n'),
        )
        .setFooter({ text: 'Raw events are kept for 30 days.' }),
    ],
  });
}

async function connection(interaction, client, gameData) {
  const robloxGame = client.getSystem('roblox').game;

  const [hasData, recent, universe] = await Promise.all([
    gameData.hasData(interaction.guildId),
    gameData.recentEvents(interaction.guildId, { limit: 1 }),
    robloxGame.configured
      ? robloxGame.getStats().then(
          (value) => (value ? `${Emojis.CHECK} ${value.name}` : `${Emojis.CROSS} universe not found — check ROBLOX_UNIVERSE_ID`),
          () => `${Emojis.ALERT} Roblox API unreachable`,
        )
      : Promise.resolve(`${Emojis.CROSS} ROBLOX_UNIVERSE_ID not set`),
  ]);

  const web = client.getSystem('web');
  const last = recent[0];
  const fresh = last && Date.now() - new Date(last.occurredAt).getTime() < 15 * 60_000;

  // `listening`, not `enabled`: configured-but-not-bound must not read as up.
  const webState = web?.listening
    ? `${Emojis.CHECK} running`
    : web?.enabled
      ? `${Emojis.ALERT} enabled but not listening — check the log for a port error`
      : `${Emojis.CROSS} disabled (WEB_ENABLED)`;

  await interaction.editReply({
    embeds: [
      embeds
        .brand('🔌 Game connection')
        .addFields(
          field('Roblox live stats', universe),
          field('Web server', webState, true),
          field(
            'Ingest endpoint',
            web?.ingest?.configured
              ? `${Emojis.CHECK} configured`
              : `${Emojis.CROSS} no GAME_API_KEY set`,
            true,
          ),
          field(
            'Data received',
            hasData ? `${Emojis.CHECK} yes` : `${Emojis.CROSS} nothing yet`,
            true,
          ),
          field(
            'Last event',
            last
              ? `${last.type} · ${timestamp(last.occurredAt, 'R')}${fresh ? '' : '\n⚠️ nothing in the last 15 minutes'}`
              : 'Never',
          ),
          field(
            'Setup',
            'The game must POST events to `/api/v1/events`. See `docs/GAME-INTEGRATION.md` for the Luau module.',
          ),
        ),
    ],
  });
}

function notConnected(universeConfigured = true) {
  const live = universeConfigured
    ? ''
    : 'Set `ROBLOX_UNIVERSE_ID` in .env for live player counts from Roblox. ';
  return (
    `No game data yet. ${live}Per-player playtime, levels and purchases cannot be read ` +
    'from Roblox — the game has to send them. Run `/game connection` to check setup.'
  );
}
