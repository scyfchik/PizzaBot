/**
 * Hermetic test environment. Import this FIRST in every test file.
 *
 * `src/config/env.js` loads the real `.env`, and dotenv never overwrites a
 * variable that is already set — so every variable the app reads is pinned
 * here, before any source module is imported. That guarantees a test can never
 * pick up the real bot token, touch the real Atlas database, or reach the real
 * Discord server, whatever the developer's `.env` contains.
 *
 * MONGO_URI points at a closed port on purpose: a test that forgets to start
 * the in-memory database fails fast instead of silently using a real one.
 */
const pinned = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  BOT_TOKEN: 'test.token.not-real',
  CLIENT_ID: '100000000000000001',
  GUILD_ID: '100000000000000002',
  OWNER_IDS: '100000000000000003',
  MONGO_URI: 'mongodb://127.0.0.1:1/not-a-real-database',
  AUTO_DEPLOY_COMMANDS: 'false',
  WEB_ENABLED: 'false',
  WEB_PORT: '3000',
  WEB_HOST: '127.0.0.1',
  WEB_BASE_URL: '',
  WEB_PUBLIC_URL: '',
  WEB_TRUST_PROXY: 'false',
  GAME_API_KEY: '',
  GAME_ALLOW_BEARER: 'false',
  ROBLOX_GROUP_ID: '',
  ROBLOX_UNIVERSE_ID: '',
  SETUP_STAFF_ROLE: '',
  SETUP_TICKET_CATEGORY: '',
  SETUP_LOG_SECURITY: '',
  SETUP_LOG_MODERATION: '',
  SETUP_LOG_TICKETS: '',
  SETUP_LOG_STAFF: '',
  SETUP_LOG_SERVER: '',
};

for (const [key, value] of Object.entries(pinned)) process.env[key] = value;

/**
 * Override variables for one test file.
 *
 * Static imports are hoisted above this call, so a file that needs different
 * values must call `setEnv` and then load source modules with `await import()`.
 * Each test file runs in its own process, so this never leaks between files.
 */
export function setEnv(values) {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}
