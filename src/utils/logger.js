import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from '../config/env.js';

/**
 * Process-level logger (stdout + rotating-by-day file).
 *
 * This is the *operational* log — crashes, database state, handler errors.
 * It is deliberately separate from the Discord embed audit log in
 * `systems/logging`, which is what staff actually read. Never log tokens,
 * message content of private tickets, or full member objects here.
 */

const LOG_DIR = join(process.cwd(), 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const fileName = `pizzabot-${new Date().toISOString().slice(0, 10)}.log`;
const fileStream = createWriteStream(join(LOG_DIR, fileName), { flags: 'a' });

/**
 * Pretty printing runs as a synchronous stream, not `pino.transport`.
 *
 * `pino.transport` spawns a worker thread, and on Windows a `process.exit()`
 * that lands while that worker is being torn down crashes the process with a
 * libuv assertion instead of exiting cleanly. Scripts like `deploy` and
 * `doctor` exit immediately after logging, so that race is guaranteed to bite.
 * The synchronous stream has no worker and no race.
 */
const streams = [
  {
    level: env.logLevel,
    stream: env.isProduction
      ? process.stdout
      : pretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }),
  },
  { level: 'info', stream: fileStream },
];

export const logger = pino(
  {
    level: env.logLevel,
    base: { app: 'pizzabot' },
    redact: {
      paths: ['token', '*.token', 'BOT_TOKEN', 'MONGO_URI', '*.apiKey'],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      /**
       * Keep errors to the four fields anyone actually reads.
       *
       * Pino's default serialiser walks the whole object. A Mongoose
       * connection error carries a full topology description, and a
       * DiscordAPIError carries the entire request body — logging either
       * verbatim buries the one line that matters under hundreds.
       */
      err: (err) => {
        if (!err || typeof err !== 'object') return err;
        return {
          type: err.name ?? err.constructor?.name,
          message: err.message,
          ...(err.code !== undefined && { code: err.code }),
          ...(err.status !== undefined && { status: err.status }),
          stack: err.stack,
        };
      },
    },
  },
  pino.multistream(streams),
);

/** Child logger tagged with a subsystem name, e.g. `createLogger('anti-raid')`. */
export function createLogger(scope) {
  return logger.child({ scope });
}
