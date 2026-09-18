import { env, assertEnvValid } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './database/connection.js';
import './database/models/index.js'; // registers every schema before indexing
import { PizzaClient } from './core/PizzaClient.js';
import { logger } from './utils/logger.js';
import { exitSoon } from './utils/exit.js';

/**
 * Entrypoint.
 *
 * Boot order is deliberate: validate configuration, then the database, then
 * load handlers, and only then connect to Discord. The bot must never be
 * online-but-broken — a command that silently fails to write a case is worse
 * than a bot that is visibly offline.
 */

/** Held so a failed startup can still tear down cleanly. */
let botClient = null;

async function main() {
  assertEnvValid();
  logger.info({ env: env.nodeEnv }, "Starting Pizza Guy's Time bot");

  await connectDatabase();

  botClient = new PizzaClient();
  await botClient.loadAll();

  installProcessHandlers(botClient);

  await botClient.login(env.discord.token);
}

function installProcessHandlers(client) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Backstop only. Normal shutdown sets an exit code and lets the event loop
    // drain — calling process.exit() while discord.js is still closing its
    // WebSocket crashes the process with a libuv assertion on Windows. This
    // timer is unref'd, so it never keeps the process alive by itself.
    const timeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      await client.shutdown();
      await disconnectDatabase();
      logger.info('Shutdown complete');
      exitSoon(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      exitSoon(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A rejected promise usually means a Discord API call we forgot to guard.
  // Log it with full context and keep running — one failed action should not
  // take the bot offline.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  // An uncaught exception leaves the process in an unknown state. Log it and
  // exit so the process manager restarts us clean.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    shutdown('uncaughtException').finally(() => exitSoon(1));
  });
}

main().catch(async (err) => {
  // Startup failures are usually a wrong token or an unreachable database.
  // Keep the message readable; the stack goes to the log file at debug level.
  logger.fatal(`Startup failed: ${err?.message ?? err}`);
  logger.debug({ err }, 'Startup failure detail');

  // An open Mongo pool keeps the event loop alive, so a failed login would
  // otherwise hang the process instead of exiting.
  await botClient?.shutdown().catch(() => {});
  await disconnectDatabase().catch(() => {});

  exitSoon(1);
});
