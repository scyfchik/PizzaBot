import { pathToFileURL } from 'node:url';
import { collectFiles } from './CommandRegistry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('events');

/**
 * Loads every gateway event handler under `src/events/**` and binds it.
 *
 * An event module exports:
 *   `name`   — a discord.js Events value
 *   `once?`  — bind with `client.once`
 *   `execute` — (client, ...args) => Promise<void>
 *
 * Handlers are wrapped so a throw inside one listener cannot take down the
 * process or stop other listeners for the same event from running. Gateway
 * events arrive unsolicited; there is nobody to report an error to, so it goes
 * to the operational log and the bot keeps running.
 */
export async function loadEvents(client, baseDir) {
  const files = await collectFiles(baseDir);
  let count = 0;

  for (const file of files) {
    const module = await import(pathToFileURL(file).href);

    if (!module.name || typeof module.execute !== 'function') {
      log.warn({ file }, 'Skipped: missing `name` or `execute` export');
      continue;
    }

    const handler = async (...args) => {
      try {
        await module.execute(client, ...args);
      } catch (err) {
        log.error({ err, event: module.name, file }, 'Event handler threw');
      }
    };

    if (module.once) client.once(module.name, handler);
    else client.on(module.name, handler);
    count += 1;
  }

  log.info({ count }, 'Event handlers bound');
}
