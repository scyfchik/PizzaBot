/**
 * In-memory MongoDB for tests that touch the database.
 *
 * Import after `./env.js`. Top-level await means the server is running and
 * MONGO_URI points at it before any source module is loaded.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

// The first run downloads a mongod binary, which can take a while.
process.env.MONGOMS_STARTUP_TIMEOUT ??= '180000';

export const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri('pizzabot-test');

/** Connect the app's own mongoose connection and register every model. */
export async function connect() {
  const { connectDatabase } = await import('../../src/database/connection.js');
  await import('../../src/database/models/index.js');
  await connectDatabase();
}

export async function disconnect() {
  const { disconnectDatabase } = await import('../../src/database/connection.js');
  await disconnectDatabase();
  await mongod.stop();
}
