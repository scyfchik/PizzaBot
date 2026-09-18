import { GuildConfig } from '../database/models/GuildConfig.js';
import { DEFAULT_RANKS } from './constants.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('guild-config');

/**
 * Cached access to per-guild configuration.
 *
 * Permission checks run on every interaction and the security detectors read
 * thresholds on every join. A database round trip there would be both slow and
 * expensive, so configs are cached in memory and invalidated explicitly on
 * write — not by a short TTL, because a stale security threshold during an
 * incident is exactly the thing we are trying to avoid.
 */

const cache = new Map();

/** Fetch (and create if missing) the config for a guild. */
export async function getConfig(guildId) {
  const cached = cache.get(guildId);
  if (cached) return cached;

  let config = await GuildConfig.findOne({ guildId });
  if (!config) {
    config = await GuildConfig.create({
      guildId,
      staffRanks: DEFAULT_RANKS.map((r) => ({ ...r, roleIds: [] })),
    });
    log.info({ guildId }, 'Created default guild configuration');
  }

  cache.set(guildId, config);
  return config;
}

/**
 * Apply a Mongo update and refresh the cache.
 * Always use this rather than `config.save()` from a caller — otherwise the
 * cached copy and the database diverge.
 */
export async function updateConfig(guildId, update) {
  const config = await GuildConfig.findOneAndUpdate({ guildId }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
  cache.set(guildId, config);
  return config;
}

/** Persist a document that a caller mutated in place. */
export async function saveConfig(config) {
  await config.save();
  cache.set(config.guildId, config);
  return config;
}

export function invalidateConfig(guildId) {
  cache.delete(guildId);
}

export function clearConfigCache() {
  cache.clear();
}
