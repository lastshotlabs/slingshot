// MongoDB connection management — no module-level mutable state.
//
// Phase 1 singleton elimination: connect functions return their connections
// directly instead of storing them in module globals. Module-level proxy
// objects (authConnection, appConnection, mongoose) are removed.
// Use getMongoFromApp(app) for context-aware access.
import { log } from '@framework/lib/logger';
import type { Connection, Mongoose } from 'mongoose';
import { getContext } from '@lastshotlabs/slingshot-core';

type MongooseModule = Mongoose;

/** Lazy mongoose module loader — caching a require() result, not runtime state. */
function requireMongoose(): MongooseModule {
  try {
    // Bun supports require() in ESM; this defers the import to call time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('mongoose') as unknown as { default?: MongooseModule } & MongooseModule;
    return mod.default ?? mod;
  } catch {
    throw new Error('mongoose is not installed. Run: bun add mongoose');
  }
}

function buildUri(user: string, password: string, host: string, db: string): string {
  const [hostPart, queryPart] = host.split('?');
  return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostPart.replace(/\/$/, '')}/${db}${queryPart ? `?${queryPart}` : ''}`;
}

// ---------------------------------------------------------------------------
// Credentials — required, resolved by SecretRepository before connection
// ---------------------------------------------------------------------------

export interface MongoCredentials {
  user: string;
  password: string;
  host: string;
  db: string;
}

// ---------------------------------------------------------------------------
// Connect functions — return connections directly
// ---------------------------------------------------------------------------

export interface MongoConnections {
  authConn: Connection;
  appConn: Connection;
  mongoose: MongooseModule;
}

/**
 * Connect the auth connection to its dedicated MongoDB server.
 *
 * @param creds Credentials resolved by SecretRepository. No process.env fallback.
 */
export const connectAuthMongo = async (
  creds: MongoCredentials,
): Promise<{ authConn: Connection; mongoose: MongooseModule }> => {
  const mg = requireMongoose();
  const authConn = mg.createConnection();
  const uri = buildUri(creds.user, creds.password, creds.host, creds.db);
  await authConn.openUri(uri);
  log(`[mongo] auth connected to ${creds.host} as ${creds.user}`);
  return { authConn, mongoose: mg };
};

/**
 * Connect the app connection to its MongoDB server.
 *
 * @param creds Credentials resolved by SecretRepository. No process.env fallback.
 */
export const connectAppMongo = async (
  creds: MongoCredentials,
): Promise<{ appConn: Connection; mongoose: MongooseModule }> => {
  const mg = requireMongoose();
  const appConn = mg.createConnection();
  const uri = buildUri(creds.user, creds.password, creds.host, creds.db);
  await appConn.openUri(uri);
  log(`[mongo] app connected to ${creds.host} as ${creds.user}`);
  return { appConn, mongoose: mg };
};

/**
 * Connect both auth and app connections to the same MongoDB server.
 * Shorthand for single-DB setups.
 *
 * @param creds Credentials resolved by SecretRepository. No process.env fallback.
 */
export const connectMongo = async (creds: MongoCredentials): Promise<MongoConnections> => {
  const mg = requireMongoose();
  const authConn = mg.createConnection();
  const appConn = mg.createConnection();
  const uri = buildUri(creds.user, creds.password, creds.host, creds.db);
  await Promise.all([authConn.openUri(uri), appConn.openUri(uri)]);
  log(`[mongo] connected to ${creds.host} as ${creds.user}`);
  return { authConn, appConn, mongoose: mg };
};

/**
 * Context-aware Mongo getter. Returns the instance-scoped connections from
 * SlingshotContext. Throws if no SlingshotContext is attached to the app.
 * Returns null when Mongo is not configured on the context.
 */
export const getMongoFromApp = (
  app: object,
): { auth: Connection | null; app: Connection | null } | null => {
  const ctx = getContext(app);
  if (ctx.mongo) {
    return {
      auth: (ctx.mongo.auth as Connection | null) ?? null,
      app: (ctx.mongo.app as Connection | null) ?? null,
    };
  }
  return null;
};

/**
 * Close both auth and app Mongo connections.
 * Accepts connections as parameters — no module-level state.
 */
export const disconnectMongo = async (
  authConn: Connection | null,
  appConn: Connection | null,
): Promise<void> => {
  await Promise.all([
    authConn && (authConn.readyState as number) !== 0 ? authConn.close() : Promise.resolve(),
    appConn && (appConn.readyState as number) !== 0 ? appConn.close() : Promise.resolve(),
  ]);
  log('[mongo] disconnected');
};

/**
 * Get the mongoose module (lazy-loaded). Useful for consumers that need
 * the mongoose module without a connection (e.g., Schema class access).
 */
export const getMongooseModule = (): MongooseModule => requireMongoose();
