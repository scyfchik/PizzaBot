import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { env, assertEnvValid } from '../config/env.js';
import { CommandRegistry } from '../core/CommandRegistry.js';
import { logger } from '../utils/logger.js';

/**
 * Registers slash commands with Discord.
 *
 * Guild-scoped on purpose: guild commands update instantly, global commands can
 * take up to an hour to propagate. This bot serves one server, so there is no
 * reason to wait.
 *
 *   npm run deploy         register every command
 *   npm run deploy:clear   remove all commands from the guild
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  assertEnvValid();

  const clear = process.argv.includes('--clear');
  const rest = new REST({ version: '10' }).setToken(env.discord.token);
  const route = Routes.applicationGuildCommands(env.discord.clientId, env.discord.guildId);

  if (clear) {
    await rest.put(route, { body: [] });
    logger.info({ guildId: env.discord.guildId }, 'Cleared all guild commands');
    return;
  }

  const registry = new CommandRegistry();
  await registry.load(join(SRC, 'commands'));

  const body = registry.toJSON();
  const result = await rest.put(route, { body });

  logger.info(
    { count: result.length, guildId: env.discord.guildId },
    'Slash commands deployed',
  );
  for (const command of result) logger.info(`  /${command.name}`);
}

/**
 * Discord API errors carry the entire request body, which for a command deploy
 * is several thousand lines of JSON. Logging the raw error buries the one line
 * that matters, so translate the common failures into something actionable.
 */
function explain(err) {
  switch (err?.status) {
    case 401:
      return 'Unauthorized — BOT_TOKEN is wrong or has been reset.';
    case 403:
      return 'Forbidden — the bot is not in that guild, or was invited without the `applications.commands` scope.';
    case 404:
      return 'Not found — check CLIENT_ID and GUILD_ID.';
    case 400:
      return `Discord rejected a command definition: ${err.rawError?.message ?? err.message}`;
    default:
      return err?.message ?? String(err);
  }
}

main().catch((err) => {
  logger.fatal(`Command deployment failed: ${explain(err)}`);
  process.exitCode = 1;
});
