import { pathToFileURL } from 'node:url';
import { collectFiles } from './CommandRegistry.js';
import { parseId } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('interactions');

/**
 * Routes button, select-menu and modal interactions to their handlers.
 *
 * Handlers register a `domain` and a list of `actions` matching the custom-ID
 * grammar in utils/ids.js (`pgt:<domain>:<action>:<args>`). Components are
 * therefore stateless across restarts: nothing is stored in memory about a
 * button, so a panel posted last month still works after a redeploy.
 *
 * A handler module exports:
 *   `domain`  — string, e.g. 'ticket'
 *   `actions` — string[] of actions it handles
 *   `execute` — (interaction, { args, client }) => Promise<void>
 */
export class InteractionRouter {
  constructor() {
    /** `${domain}:${action}` -> handler */
    this.handlers = new Map();
  }

  async load(baseDir) {
    const files = await collectFiles(baseDir);
    for (const file of files) {
      const module = await import(pathToFileURL(file).href);

      if (!module.domain || !Array.isArray(module.actions) || typeof module.execute !== 'function') {
        log.warn({ file }, 'Skipped: missing `domain`, `actions` or `execute`');
        continue;
      }

      for (const action of module.actions) {
        const key = `${module.domain}:${action}`;
        if (this.handlers.has(key)) {
          log.error({ file, key }, 'Duplicate interaction handler — skipped');
          continue;
        }
        this.handlers.set(key, module.execute);
      }
    }
    log.info({ count: this.handlers.size }, 'Interaction handlers loaded');
  }

  /**
   * Resolve a custom ID to `{ execute, args }`, or `null` when the component
   * is not ours — foreign components (Dyno, Carl-bot) must be ignored silently.
   */
  resolve(customId) {
    const parsed = parseId(customId);
    if (!parsed) return null;

    const execute = this.handlers.get(`${parsed.domain}:${parsed.action}`);
    if (!execute) return null;

    return { execute, args: parsed.args };
  }
}
