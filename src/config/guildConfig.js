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
      schemaVersion: CONFIG_SCHEMA_VERSION,
    });
    log.info({ guildId }, 'Created default guild configuration');
  } else if ((config.schemaVersion ?? 1) < CONFIG_SCHEMA_VERSION) {
    await migrate(config);
  }

  cache.set(guildId, config);
  return config;
}

/**
 * Bump when DEFAULT_RANKS gains permission nodes that existing guilds should
 * receive. v2: player.view / player.economy / game.stats / game.events / qa.*,
 * which live ranks never got because they were seeded before those existed —
 * leaving every rank below Game Director unable to use /player or /game.
 */
export const CONFIG_SCHEMA_VERSION = 2;

/**
 * Grant each existing rank the default nodes it is missing, matched by rank key.
 *
 * Only ever *adds*. It cannot tell a node an admin deliberately removed from
 * one that never existed, so it runs exactly once per schema version rather
 * than on every start — after that, `/config rank permission` is the only way
 * nodes change. Custom ranks (keys not in the defaults) are left alone.
 */
async function migrate(config) {
  const defaults = new Map(DEFAULT_RANKS.map((r) => [r.key, r.permissions]));
  const granted = [];

  for (const rank of config.staffRanks) {
    const wanted = defaults.get(rank.key);
    if (!wanted || rank.permissions.includes('*')) continue;

    const missing = wanted.filter((node) => !rank.permissions.includes(node));
    if (!missing.length) continue;

    rank.permissions.push(...missing);
    granted.push({ rank: rank.name, added: missing });
  }

  const from = config.schemaVersion ?? 1;
  config.schemaVersion = CONFIG_SCHEMA_VERSION;
  await config.save();

  log.warn(
    { guildId: config.guildId, from, to: CONFIG_SCHEMA_VERSION, granted },
    granted.length
      ? 'Guild config migrated — ranks received permission nodes added since they were created'
      : 'Guild config migrated — no rank needed new nodes',
  );
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
