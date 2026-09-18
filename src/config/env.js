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

/** `true`/`1`/`yes` are true; anything else falls back to the default. */
function bool(key, fallback = false) {
  const value = optional(key);
  if (value === null) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function number(key, fallback) {
  const value = optional(key);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    errors.push(`${key} must be a port number between 1 and 65535, got: ${value}`);
    return fallback;
  }
  return parsed;
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

  /**
   * Transcript web viewer.
   *
   * Deployment-level settings, so they live here rather than in the database:
   * a port and a public hostname are properties of the machine, not of the
   * guild. Per-guild behaviour (expiry, whether links are generated at all)
   * stays in GuildConfig.
   */
  web: Object.freeze({
    enabled: bool('WEB_ENABLED', false),
    port: number('WEB_PORT', 3000),
    /**
     * Binds to loopback by default. Publishing user-submitted ticket content
     * straight onto a public interface should be a deliberate act, not what
     * happens because someone left a default alone — put a reverse proxy in
     * front and terminate TLS there, or set this to 0.0.0.0 knowingly.
     */
    host: optional('WEB_HOST', '127.0.0.1'),
    /** Public origin used to build links, e.g. https://tickets.example.com */
    baseUrl: optional('WEB_BASE_URL')?.replace(/\/+$/, '') ?? null,
    /** Read X-Forwarded-For for rate limiting. Only enable behind a proxy. */
    trustProxy: bool('WEB_TRUST_PROXY', false),
  }),

  /**
   * Game → bot ingest.
   *
   * The shared secret your Roblox game signs its reports with. Store it in the
   * game's server-side storage only — a key in a LocalScript is a public key.
   */
  game: Object.freeze({
    apiKey: optional('GAME_API_KEY'),
    /**
     * Accept a plain `Authorization: Bearer <key>` instead of a signature.
     * Weaker: anything that observes the request observes the key. Only
     * sensible over HTTPS, and never the default.
     */
    allowBearer: bool('GAME_ALLOW_BEARER', false),
  }),

  /** Reserved for the future Roblox integration — read but never used yet. */
  roblox: Object.freeze({
    groupId: optional('ROBLOX_GROUP_ID'),
    universeId: optional('ROBLOX_UNIVERSE_ID'),
    apiKey: optional('ROBLOX_API_KEY'),
  }),
});

// A transcript server with no public origin can serve pages but cannot build a
// working link, which would silently post dead URLs into the ticket log.
if (env.web.enabled && !env.web.baseUrl) {
  errors.push('WEB_BASE_URL is required when WEB_ENABLED is true');
}
if (env.web.enabled && env.web.baseUrl && !/^https?:\/\//i.test(env.web.baseUrl)) {
  errors.push(`WEB_BASE_URL must start with http:// or https://, got: ${env.web.baseUrl}`);
}

// A short shared secret is no secret. 32 characters is the minimum that makes
// offline guessing pointless.
if (env.game.apiKey && env.game.apiKey.length < 32) {
  errors.push('GAME_API_KEY must be at least 32 characters — generate a random one');
}
if (env.game.apiKey && !env.web.enabled) {
  errors.push('GAME_API_KEY is set but WEB_ENABLED is false, so nothing can receive game events');
}

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
