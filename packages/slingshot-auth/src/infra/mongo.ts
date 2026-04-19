// Auth-internal Mongo utilities.
// Connection handles are injected via runtimeInfra — no context threading.
import { createRequire } from 'node:module';
import type { Connection, Mongoose } from 'mongoose';

const require = createRequire(import.meta.url);

/**
 * Returns the provided Mongoose instance, or lazily `require()`s it from the host project.
 *
 * Mongoose is an optional peer dependency of slingshot-auth.  This function defers the
 * import to call time so that apps which do not use the Mongo auth adapter are never
 * forced to install mongoose.
 *
 * @param mg - An already-imported Mongoose instance.  When provided it is returned
 *   as-is, bypassing the dynamic require.
 * @returns The resolved `Mongoose` instance.
 * @throws {Error} If `mg` is absent and `mongoose` is not installed in the host project.
 *   Message: `"mongoose is not installed. Run: bun add mongoose"`.
 *
 * @example
 * import mongoose from 'mongoose';
 * const mg = resolveMongoose(mongoose); // returns mongoose directly
 *
 * // Or without a pre-imported instance (lazy, throws if not installed):
 * const mg = resolveMongoose();
 */
export function resolveMongoose(mg?: Mongoose): Mongoose {
  if (mg) return mg;
  try {
    const mod = require('mongoose');
    return mod.default ?? mod;
  } catch {
    throw new Error('mongoose is not installed. Run: bun add mongoose');
  }
}

/**
 * Create a proxy-based connection accessor that lazily resolves to the actual connection.
 * Returns a Proxy that allows model registration at module load time before connections
 * are established.
 */
export function makeConnectionProxy(
  label: string,
  getConn: () => Connection | null,
  mongooseInstance?: Mongoose,
): Connection {
  const target: Connection = {} as Connection; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- Proxy target is intentionally empty
  return new Proxy(target, {
    get(_, prop) {
      let conn = getConn();
      if (!conn) {
        // Lazily create a disconnected connection so .model() works at import time
        const mg = resolveMongoose(mongooseInstance);
        conn = mg.createConnection();
      }
      const val = (conn as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(conn) : val;
    },
  });
}

/**
 * Create a mongoose proxy that lazily resolves the mongoose instance.
 */
export function makeMongooseProxy(getMongoose: () => Mongoose): Mongoose {
  const target: Mongoose = {} as Mongoose; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- Proxy target is intentionally empty
  return new Proxy(target, {
    get(_, prop) {
      const mg = getMongoose();
      return (mg as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}
