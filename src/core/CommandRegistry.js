import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Collection } from 'discord.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('commands');

/**
 * Loads every command module under `src/commands/**` and holds them by name.
 *
 * A command module exports:
 *   `data`     — a SlashCommandBuilder
 *   `meta`     — { permission, hierarchy?, cooldown?, guildOnly? }
 *   `execute`  — (interaction, client) => Promise<void>
 *   `autocomplete?` — optional handler
 *
 * The folder layout (moderation/, tickets/, …) is purely for humans; commands
 * are addressed by their Discord name, not their path.
 */
export class CommandRegistry {
  constructor() {
    this.commands = new Collection();
    /** userId:commandName -> timestamp, for per-command cooldowns. */
    this.cooldowns = new Collection();
  }

  async load(baseDir) {
    const files = await collectFiles(baseDir);
    for (const file of files) {
      const module = await import(pathToFileURL(file).href);

      if (!module.data || typeof module.execute !== 'function') {
        log.warn({ file }, 'Skipped: missing `data` or `execute` export');
        continue;
      }
      if (this.commands.has(module.data.name)) {
        log.error({ file, name: module.data.name }, 'Duplicate command name — skipped');
        continue;
      }

      this.commands.set(module.data.name, {
        data: module.data,
        meta: module.meta ?? {},
        execute: module.execute,
        autocomplete: module.autocomplete ?? null,
      });
    }
    log.info({ count: this.commands.size }, 'Commands loaded');
    return this.commands;
  }

  get(name) {
    return this.commands.get(name) ?? null;
  }

  /** JSON bodies for the REST deployment script. */
  toJSON() {
    return this.commands.map((c) => c.data.toJSON());
  }

  /**
   * Returns remaining cooldown in ms, or 0 if the command may run.
   * Cooldowns exist to stop accidental double-clicks and command spam in
   * ticket channels — not as a security control.
   */
  checkCooldown(userId, commandName, seconds) {
    if (!seconds) return 0;
    const key = `${userId}:${commandName}`;
    const expiresAt = this.cooldowns.get(key) ?? 0;
    const now = Date.now();
    if (expiresAt > now) return expiresAt - now;
    this.cooldowns.set(key, now + seconds * 1000);
    return 0;
  }
}

/** Recursively collect `.js` files, ignoring `_`-prefixed helpers. */
async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (extname(entry.name) === '.js' && !entry.name.startsWith('_')) {
      files.push(full);
    }
  }
  return files;
}

export { collectFiles };
