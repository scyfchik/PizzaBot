import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');

/**
 * Single shared Mongoose connection.
 *
 * Buffering is disabled on purpose: if the database is down we want commands to
 * fail fast with a clear error instead of hanging until Discord's 3s
 * interaction deadline expires and the user sees "application did not respond".
 */
/** Set while shutting down, so in-flight operations stop reporting as failures. */
let closing = false;

export async function connectDatabase() {
  closing = false;

  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);

  mongoose.connection.on('connected', () => log.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => {
    if (!closing) log.error({ err }, 'MongoDB error');
  });

  await mongoose.connect(env.mongo.uri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 20,
    minPoolSize: 2,
    retryWrites: true,
    autoIndex: !env.isProduction, // build indexes explicitly in production
  });

  return mongoose.connection;
}

/**
 * Build indexes in the background.
 *
 * Deliberately separate from `connectDatabase` and called only once the bot is
 * actually ready. Two reasons: index creation on a cold cluster can take tens
 * of seconds and must not delay the bot coming online, and a build left pending
 * from a failed startup keeps the event loop alive long after there is nothing
 * to do. Queries work without the indexes, just slower.
 */
export function ensureIndexes() {
  if (!env.isProduction) return; // dev uses autoIndex

  Promise.all(
    Object.values(mongoose.models).map((model) =>
      model.createIndexes().catch((err) => {
        // A shutdown mid-build is expected, not a fault worth reporting.
        if (!closing) log.error({ err, model: model.modelName }, 'Failed to build indexes');
      }),
    ),
  ).then(() => {
    if (!closing) log.info('Indexes ensured');
  });
}

export async function disconnectDatabase() {
  // Set before the early return: a connection that never opened still emits
  // error events afterwards, and those are expected noise once we are closing.
  closing = true;
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  log.info('MongoDB connection closed');
}

export function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}
