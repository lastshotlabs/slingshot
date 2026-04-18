import type { Connection, Document, Model, Mongoose } from 'mongoose';

interface IGroup {
  name: string;
  displayName?: string;
  description?: string;
  roles: string[];
  /**
   * null = app-wide group, string = tenant-scoped group.
   * Immutable after creation — adapters must reject updates that include tenantId.
   */
  tenantId: string | null;
}

type GroupDocument = IGroup & Document;

/**
 * Creates (or retrieves a cached) Mongoose `Group` model on the given connection.
 *
 * Checks `conn.models['Group']` before defining a new schema to avoid the
 * "Cannot overwrite model once compiled" error on module re-evaluation. When absent,
 * defines the schema and registers the model on the connection.
 *
 * @param conn - The Mongoose `Connection` to register the model on.  Use a
 *   per-app connection to avoid cross-app state pollution in multi-tenant setups.
 * @param mongooseInstance - The `Mongoose` class instance used for `Schema` and
 *   `model` construction.
 * @returns The `Group` Mongoose `Model<GroupDocument>` registered on `conn`.
 *
 * @remarks
 * Model caching is per-connection — each `conn` instance gets its own independent
 * model registration. A compound `{ name, tenantId }` unique index enforces name
 * uniqueness within scope: app-wide groups (both `null`) and per-tenant groups are
 * kept separate. `tenantId` is immutable after creation; adapters must reject updates
 * that attempt to change it.
 *
 * @example
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const Group = createGroupModel(conn, mongoose);
 * const group = await Group.findOne({ name: 'admins', tenantId: null });
 */
export function createGroupModel(
  conn: Connection,
  mongooseInstance: Mongoose,
): Model<GroupDocument> {
  if ('Group' in conn.models) return conn.models['Group'] as Model<GroupDocument>;

  const { Schema } = mongooseInstance;
  const schema = new Schema<GroupDocument>(
    {
      name: { type: String, required: true },
      displayName: { type: String },
      description: { type: String },
      roles: [{ type: String }],
      tenantId: { type: String, default: null },
    },
    { timestamps: true, autoIndex: false },
  );

  // Name is unique within scope (app-wide or per-tenant).
  // MongoDB treats null as a value, so this compound index correctly enforces uniqueness
  // for app-wide groups (both have tenantId: null) and per-tenant groups separately.
  schema.index({ name: 1, tenantId: 1 }, { unique: true });
  schema.index({ tenantId: 1 });

  return conn.model<GroupDocument>('Group', schema);
}
