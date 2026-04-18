import type { Connection, Document, Model, Mongoose } from 'mongoose';

interface ITenantRole {
  userId: string;
  tenantId: string;
  roles: string[];
}

type TenantRoleDocument = ITenantRole & Document;

/**
 * Creates (or retrieves a cached) Mongoose `TenantRole` model on the given connection.
 *
 * Checks `conn.models['TenantRole']` before defining a new schema to avoid the
 * "Cannot overwrite model once compiled" error on module re-evaluation. When absent,
 * defines the schema and registers the model on the connection.
 *
 * @param conn - The Mongoose `Connection` to register the model on.  Use a
 *   per-app connection to avoid cross-app state pollution in multi-tenant setups.
 * @param mongooseInstance - The `Mongoose` class instance used for `Schema` and
 *   `model` construction.
 * @returns The `TenantRole` Mongoose `Model<TenantRoleDocument>` registered on `conn`.
 *
 * @remarks
 * Model caching is per-connection. Stores the set of roles a user holds within a specific
 * tenant. A compound `{ userId, tenantId }` unique index ensures at most one role document
 * per user per tenant; roles are updated in-place via `$set`. A `{ tenantId }` index
 * supports efficient "list all members of tenant X" queries.
 *
 * @example
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const TenantRole = createTenantRoleModel(conn, mongoose);
 * const record = await TenantRole.findOne({ userId: 'user-123', tenantId: 'tenant-abc' });
 */
export function createTenantRoleModel(
  conn: Connection,
  mongooseInstance: Mongoose,
): Model<TenantRoleDocument> {
  if ('TenantRole' in conn.models) return conn.models['TenantRole'] as Model<TenantRoleDocument>;

  const { Schema } = mongooseInstance;
  const schema = new Schema<TenantRoleDocument>(
    {
      userId: { type: String, required: true },
      tenantId: { type: String, required: true },
      roles: [{ type: String }],
    },
    { timestamps: true, autoIndex: false },
  );

  schema.index({ userId: 1, tenantId: 1 }, { unique: true });
  schema.index({ tenantId: 1 });

  return conn.model<TenantRoleDocument>('TenantRole', schema);
}
