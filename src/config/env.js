import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: resolve(__dirname, '../../.env')
});

/**
 * Environment loading and validation.
 *
 * Fails fast and loudly: a bot that boots half-configured is worse than one
 * that refuses to boot. Every value is normalised here so nothing else in the
 * codebase touches `process.env`.
 *
 * Note what is *absent*: staff roles, thresholds, channels. Those live in
 * MongoDB and are set with /setup and /config. The only permission value here
 * is OWNER_IDS, which exists so you can run /setup on a fresh server.
 */

const errors = [];
const SNOWFLAKE = /^\d{17,20}$/;

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    errors.push(`${key} is required but missing or empty`);
    return null;
  }
  return value;
}

function optional(key, fallback = null) {
  return process.env[key]?.trim() || fallback;
}

/** A single snowflake, optionally required. */
function id(key, isRequired = false) {
  const value = isRequired ? required(key) : optional(key);
  if (value && !SNOWFLAKE.test(value)) {
    errors.push(`${key} is not a valid Discord ID: ${value}`);
    return null;
  }
  return value;
}

/** Comma-separated snowflakes -> deduplicated array. */
function idList(key) {
  const raw = optional(key);
  if (!raw) return [];
  const ids = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  const invalid = ids.filter((v) => !SNOWFLAKE.test(v));
  if (invalid.length) {
    errors.push(`${key} contains values that are not Discord IDs: ${invalid.join(', ')}`);
  }
  return [...new Set(ids)];
}

const nodeEnv = optional('NODE_ENV', 'development');

export const env = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  logLevel: optional('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),

  discord: Object.freeze({
    token: required('BOT_TOKEN'),
    clientId: id('CLIENT_ID', true),
    guildId: id('GUILD_ID', true),
  }),

  mongo: Object.freeze({
    uri: required('MONGO_URI'),
  }),

  /** Bypasses every permission check. The bootstrap for /setup. */
  owners: idList('OWNER_IDS'),

  /** Optional pre-fill for the /setup wizard; all of it is editable later. */
  setup: Object.freeze({
    staffRoleId: id('SETUP_STAFF_ROLE'),
    ticketCategoryId: id('SETUP_TICKET_CATEGORY'),
    logChannels: Object.freeze({
      security: id('SETUP_LOG_SECURITY'),
      moderation: id('SETUP_LOG_MODERATION'),
      tickets: id('SETUP_LOG_TICKETS'),
      staff: id('SETUP_LOG_STAFF'),
      server: id('SETUP_LOG_SERVER'),
    }),
  }),

  /** Reserved for the future Roblox integration — read but never used yet. */
  roblox: Object.freeze({
    groupId: optional('ROBLOX_GROUP_ID'),
    universeId: optional('ROBLOX_UNIVERSE_ID'),
    apiKey: optional('ROBLOX_API_KEY'),
  }),
});

/**
 * Throws if the environment is unusable. Called once from the entrypoint so a
 * misconfiguration is a clean message, not a stack trace from inside login.
 */
export function assertEnvValid() {
  if (errors.length === 0) return;
  const detail = errors.map((e) => `  - ${e}`).join('\n');
  throw new Error(
    `Invalid environment configuration:\n${detail}\n\n` +
      'Copy .env.example to .env and fill in the required values.',
  );
}
