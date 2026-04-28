// ---------------------------------------------------------------------------
// Docker service helpers
//
// Phase 1 singleton elimination: connectRedis() returns the client directly
// (no module-level storage), and disconnectRedis/disconnectMongo accept
// connection handles as parameters. We manage the handles locally here.
// ---------------------------------------------------------------------------
import type { default as RedisClass } from 'ioredis';
import type { Connection } from 'mongoose';
import { getMongooseModule } from '../src/lib/mongo';
import { connectRedis, disconnectRedis } from '../src/lib/redis';

// Preloaded by bunfig.docker.toml / bunfig.ci.toml — runs before any test module initialization.
// Sets env vars for BOTH memory tests (so they still work under this preload) and Docker tests.

// Memory / JWT env vars (same as setup.ts)
process.env.JWT_SECRET = 'test-secret-key-must-be-at-least-32-chars!!';
process.env.BEARER_TOKEN = 'test-bearer-token';
process.env.NODE_ENV = 'development';

// Redis env vars — port 6380 maps to Docker container (clear credentials so
// the no-auth Docker Redis isn't sent the .env file's production creds)
process.env.REDIS_HOST = 'localhost:6380';
delete process.env.REDIS_USER;
delete process.env.REDIS_PASSWORD;

// Mongo env vars — Docker Mongo has no auth, so e2e mongo mode uses the full URL.
process.env.MONGO_URL = 'mongodb://localhost:27018/slingshot_test';
process.env.MONGO_HOST = 'localhost:27018';
process.env.MONGO_DB = 'slingshot_test';

// Disable Mongoose autoIndex globally — indexes are created explicitly in flushTestServices
// to avoid race conditions where autoIndex runs asynchronously and create() hangs.
// Must use getMongooseModule() rather than require('mongoose') directly: Bun's CJS and ESM
// module caches are separate, so require('mongoose') returns a different instance than
// the one used by src/lib/mongo.ts (which is imported as ESM). Setting autoIndex on the
// wrong instance has no effect.
getMongooseModule().set('autoIndex', false);

// Re-export everything from setup.ts so memory tests work unchanged
export { createTestApp, authHeader } from './setup';

const EXPECTED_REDIS_PORT = 6380;
const EXPECTED_MONGO_DB = 'slingshot_test';
const MONGO_URI = 'mongodb://localhost:27018/slingshot_test';

let _redisClient: RedisClass | null = null;
let _authConn: Connection | null = null;
let _appConn: Connection | null = null;

// Track which models have had their indexes created
const _indexedModels = new Set<string>();

/** Connect to Docker Redis (port 6380). Idempotent. */
export async function connectTestRedis(): Promise<void> {
  if (_redisClient) return;
  _redisClient = await connectRedis({ host: `localhost:${EXPECTED_REDIS_PORT}` });
}

/** Get the test Redis client. Throws if not connected. */
export function getTestRedis(): RedisClass {
  if (!_redisClient) throw new Error('Test Redis not connected — call connectTestRedis() first');
  return _redisClient;
}

/** Connect to Docker MongoDB (port 27018). Idempotent.
 *  Uses plain mongodb:// URI (not SRV) since this is local Docker.
 *  Checks readyState (not just a flag) in case another test file disconnected. */
export async function connectTestMongo(): Promise<void> {
  const mg = getMongooseModule();
  const needsAuth = !_authConn || _authConn.readyState !== 1;
  const needsApp = !_appConn || _appConn.readyState !== 1;
  if (!needsAuth && !needsApp) return;
  if (needsAuth) {
    // autoIndex: false — tests manage indexes explicitly via ensureNewIndexes().
    // autoIndex=true causes hangs in Bun's test environment when the first model
    // write triggers Mongoose's internal ensureIndexes() call asynchronously.
    _authConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
  }
  if (needsApp) {
    _appConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
  }
}

/** Get the test auth connection. Throws if not connected. */
export function getTestAuthConn(): Connection {
  if (!_authConn) throw new Error('Test Mongo not connected — call connectTestMongo() first');
  return _authConn;
}

/** Get the test app connection. Throws if not connected. */
export function getTestAppConn(): Connection {
  if (!_appConn) throw new Error('Test Mongo not connected — call connectTestMongo() first');
  return _appConn;
}

/** Create indexes for any newly registered models (runs once per model). */
async function ensureNewIndexes(): Promise<void> {
  if (_authConn && _authConn.readyState === 1) {
    for (const name of _authConn.modelNames()) {
      if (!_indexedModels.has(`auth:${name}`)) {
        await _authConn.model(name).createIndexes();
        _indexedModels.add(`auth:${name}`);
      }
    }
  }
  if (_appConn && _appConn.readyState === 1) {
    for (const name of _appConn.modelNames()) {
      if (!_indexedModels.has(`app:${name}`)) {
        await _appConn.model(name).createIndexes();
        _indexedModels.add(`app:${name}`);
      }
    }
  }
}

/** Flush all test data. Uses deleteMany to preserve indexes.
 *  Includes safety guards to prevent wiping non-test services. */
export async function flushTestServices(): Promise<void> {
  // Redis safety guard
  if (_redisClient) {
    const port = (_redisClient as any).options?.port;
    if (port !== EXPECTED_REDIS_PORT) {
      throw new Error(
        `SAFETY: Expected Redis on port ${EXPECTED_REDIS_PORT}, got port ${port}. Refusing to FLUSHDB.`,
      );
    }
    await _redisClient.flushdb();
  }

  // Mongo safety guard — also check readyState in case another file disconnected
  if (_authConn && _authConn.readyState === 1) {
    const dbName = _authConn.db?.databaseName;
    if (dbName !== EXPECTED_MONGO_DB) {
      throw new Error(
        `SAFETY: Expected MongoDB database "${EXPECTED_MONGO_DB}", got "${dbName}". Refusing to drop collections.`,
      );
    }
    // Ensure indexes exist for any newly registered models (once per model)
    await ensureNewIndexes();
    // Use deleteMany (not dropCollection) to preserve indexes
    const collections = await _authConn.db!.listCollections().toArray();
    await Promise.all(collections.map(c => _authConn!.db!.collection(c.name).deleteMany({})));
  }

  if (_appConn && _appConn.readyState === 1) {
    const dbName = _appConn.db?.databaseName;
    if (dbName !== EXPECTED_MONGO_DB) {
      throw new Error(
        `SAFETY: Expected MongoDB database "${EXPECTED_MONGO_DB}", got "${dbName}". Refusing to drop collections.`,
      );
    }
    await ensureNewIndexes();
    const collections = await _appConn.db!.listCollections().toArray();
    await Promise.all(collections.map(c => _appConn!.db!.collection(c.name).deleteMany({})));
  }
}

/** Gracefully disconnect from Docker services. Call in afterAll. */
export async function disconnectTestServices(): Promise<void> {
  if (_redisClient) {
    await disconnectRedis(_redisClient);
    _redisClient = null;
  }
  if (_authConn || _appConn) {
    const authClose =
      _authConn && _authConn.readyState !== 0 ? _authConn.close() : Promise.resolve();
    const appClose = _appConn && _appConn.readyState !== 0 ? _appConn.close() : Promise.resolve();
    await Promise.all([authClose, appClose]);
    _authConn = null;
    _appConn = null;
  }
}
