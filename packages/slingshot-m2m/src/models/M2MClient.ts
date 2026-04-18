import type { Connection, Document, Model, Mongoose } from 'mongoose';

/**
 * Shape of a persisted M2M client document in MongoDB.
 *
 * `_id` is a UUID string (not ObjectId) to align with the cross-adapter ID
 * convention used throughout slingshot. `clientSecretHash` stores the argon2-hashed
 * client secret — the plaintext is never stored.
 */
export interface IM2MClient {
  /** UUID primary key. */
  _id: string;
  /** Human-readable unique identifier for the client (e.g. `'billing-service'`). */
  clientId: string;
  /** argon2id hash of the plaintext client secret. Never stored in plaintext. */
  clientSecretHash: string;
  /** Display name for the client. */
  name: string;
  /** OAuth 2.0 scopes this client is permitted to request. */
  scopes: string[];
  /** Whether the client can currently obtain tokens. Set to `false` to revoke access. */
  active: boolean;
  /** Timestamp when the client record was created. */
  createdAt: Date;
  /** Timestamp of the most recent update to the client record. */
  updatedAt: Date;
}

/**
 * Mongoose document type for a persisted M2M client.
 *
 * Extends `IM2MClient` with Mongoose `Document` methods (`save()`, `toObject()`,
 * `populate()`, etc.). Used as the generic type argument for the Mongoose `Model`
 * and `Schema` so that TypeScript can narrow document fields correctly.
 *
 * @remarks
 * This type is intentionally kept private to this module. Consumers interact
 * with `IM2MClient` plain objects returned by adapter methods — not raw
 * Mongoose documents.
 */
type M2MClientDocument = IM2MClient & Document;

/**
 * Returns the Mongoose `Model` for M2M clients on the given connection, creating
 * it on first use and returning the cached model on subsequent calls.
 *
 * @param conn - The Mongoose `Connection` to register the model on. Using a
 *   per-connection model (rather than the global `mongoose.model()`) ensures
 *   that multi-tenant setups with distinct database connections each get their
 *   own model instance without cross-connection state.
 * @param mongooseInstance - The `Mongoose` instance to pull `Schema` from.
 *   Pass this explicitly rather than importing from the global `mongoose`
 *   singleton so callers control which Mongoose version is used.
 * @returns The `Model<M2MClientDocument>` registered as `'M2MClient'` on `conn`.
 *
 * @remarks
 * Model caching is handled by Mongoose's `connection.models` registry. If
 * `conn.models['M2MClient']` already exists this function returns it directly
 * without re-defining the schema, making it safe to call multiple times.
 * The schema uses `{ timestamps: true }` so Mongoose manages `createdAt` and
 * `updatedAt` automatically. The `_id` field is a UUID string, not an ObjectId.
 *
 * @example
 * ```ts
 * import mongoose from 'mongoose';
 * import { createM2MClientModel } from './M2MClient';
 *
 * const conn = mongoose.createConnection(process.env.MONGO_URI!);
 * const M2MClient = createM2MClientModel(conn, mongoose);
 * const client = await M2MClient.findOne({ clientId: 'billing-service' });
 * ```
 */
export function createM2MClientModel(
  conn: Connection,
  mongooseInstance: Mongoose,
): Model<M2MClientDocument> {
  if (conn.modelNames().includes('M2MClient')) {
    return conn.model<M2MClientDocument>('M2MClient');
  }

  const { Schema } = mongooseInstance;
  const schema = new Schema<M2MClientDocument>(
    {
      clientId: { type: String, required: true, unique: true },
      clientSecretHash: { type: String, required: true },
      name: { type: String, required: true },
      scopes: { type: [String], default: [] },
      active: { type: Boolean, default: true },
    },
    { timestamps: true },
  );

  return conn.model<M2MClientDocument>('M2MClient', schema);
}
