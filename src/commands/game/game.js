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
  return stats(interaction, gameData);
}

async function stats(interaction, gameData) {
  const s = await gameData.serverStats(interaction.guildId);

  if (s.empty) throw new UserError(notConnected());

  const hours = Math.round(s.totalPlaytimeMinutes / 60);

  await interaction.editReply({
    embeds: [
      embeds
        .brand(`${Emojis.PIZZA} Game Statistics`)
        .addFields(
          field('🟢 Players online', String(s.online), true),
          field('🖥️ Active servers', String(s.servers), true),
          field('📅 Active today', String(s.activeToday), true),
          field('👥 Known players', s.totalPlayers.toLocaleString(), true),
          field('⏱️ Total playtime', `${hours.toLocaleString()}h`, true),
          field('💳 Lifetime spend', `R$ ${s.totalRobux.toLocaleString()}`, true),
          field(
            '💸 Today',
            `${s.purchasesToday} purchase(s)` +
              (s.failuresToday ? ` · **${s.failuresToday} failed**` : ' · 0 failed'),
            true,
          ),
        )
        .setFooter({
          text:
            s.failuresToday > 0
              ? 'Failed purchases today — expect purchase-support tickets.'
              : 'Online count is an upper bound: a crashed server never reports its leaves.',
        }),
    ],
  });
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
  const [hasData, recent] = await Promise.all([
    gameData.hasData(interaction.guildId),
    gameData.recentEvents(interaction.guildId, { limit: 1 }),
  ]);

  const web = client.getSystem('web');
  const last = recent[0];
  const fresh = last && Date.now() - new Date(last.occurredAt).getTime() < 15 * 60_000;

  await interaction.editReply({
    embeds: [
      embeds
        .brand('🔌 Game connection')
        .addFields(
          field(
            'Web server',
            web?.enabled ? `${Emojis.CHECK} running` : `${Emojis.CROSS} disabled (WEB_ENABLED)`,
            true,
          ),
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

function notConnected() {
  return (
    'Your game has not reported anything yet. Playtime, levels, purchases and events ' +
    'cannot be read from Roblox — the game has to send them. Run `/game connection` to check setup.'
  );
}
