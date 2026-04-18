import type { Connection, Document, Model, Mongoose } from 'mongoose';

export interface IM2MClient {
  _id: string;
  clientId: string;
  clientSecretHash: string;
  name: string;
  scopes: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type M2MClientDocument = IM2MClient & Document;

/**
 * Creates (or retrieves a cached) Mongoose `M2MClient` model on the given connection.
 *
 * Checks `conn.models['M2MClient']` before defining a new schema to avoid the
 * "Cannot overwrite model once compiled" error on module re-evaluation. When absent,
 * defines the schema and registers the model on the connection.
 *
 * @param conn - The Mongoose `Connection` to register the model on.  Use a
 *   per-app connection to avoid cross-app state pollution in multi-tenant setups.
 * @param mongooseInstance - The `Mongoose` class instance used for `Schema` and
 *   `model` construction.
 * @returns The `M2MClient` Mongoose `Model<M2MClientDocument>` registered on `conn`.
 *
 * @remarks
 * Model caching is per-connection. `clientId` carries a unique index. `clientSecretHash`
 * stores a bcrypt hash of the client secret — the plaintext secret is only returned at
 * creation time and is never stored or re-exposed. The `active` flag controls whether
 * the client is allowed to authenticate; set to `false` to disable without deleting.
 *
 * @example
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const M2MClient = createM2MClientModel(conn, mongoose);
 * const client = await M2MClient.findOne({ clientId: 'svc-worker-01', active: true });
 */
export function createM2MClientModel(
  conn: Connection,
  mongooseInstance: Mongoose,
): Model<M2MClientDocument> {
  if ('M2MClient' in conn.models) return conn.models['M2MClient'] as Model<M2MClientDocument>;

  const { Schema } = mongooseInstance;
  const schema = new Schema<M2MClientDocument>(
    {
      clientId: { type: String, required: true, unique: true },
      clientSecretHash: { type: String, required: true },
      name: { type: String, required: true },
      scopes: { type: [String], default: [] },
      active: { type: Boolean, default: true },
    },
    // autoIndex: false — indexes are created explicitly by the caller (flushTestServices
    // in tests, or ensureNewIndexes). Prevents autoIndex from causing hangs when the
    // first write operation triggers an async ensureIndexes() call internally.
    { timestamps: true, autoIndex: false },
  );

  return conn.model<M2MClientDocument>('M2MClient', schema);
}
