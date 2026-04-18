import type { Connection, Document, Model, Mongoose } from 'mongoose';

interface IGroupMembership {
  userId: string;
  groupId: string;
  /** Per-member extra roles on top of the group's baseline roles. */
  roles: string[];
  /**
   * Denormalized from the group at insert time for efficient tenant-scoped queries.
   * Immutable: group.tenantId cannot change after creation, so this is always consistent.
   */
  tenantId: string | null;
  /**
   * No updatedAt — intentional: we track membership existence, not when roles last changed.
   * updateGroupMembership updates roles[] in place via $set.
   * Use external audit logs if mutation history is needed.
   */
}

type GroupMembershipDocument = IGroupMembership & Document;

/**
 * Creates (or retrieves a cached) Mongoose `GroupMembership` model on the given connection.
 *
 * Checks `conn.models['GroupMembership']` before defining a new schema to avoid the
 * "Cannot overwrite model once compiled" error on module re-evaluation. When absent,
 * defines the schema and registers the model on the connection.
 *
 * @param conn - The Mongoose `Connection` to register the model on.  Use a
 *   per-app connection to avoid cross-app state pollution in multi-tenant setups.
 * @param mongooseInstance - The `Mongoose` class instance used for `Schema` and
 *   `model` construction.
 * @returns The `GroupMembership` Mongoose `Model<GroupMembershipDocument>` registered
 *   on `conn`.
 *
 * @remarks
 * Model caching is per-connection — each `conn` instance gets its own independent
 * model registration. A compound `{ userId, groupId }` unique index prevents duplicate
 * memberships. `tenantId` is denormalized from the parent group at insert time to enable
 * efficient tenant-scoped membership queries without a join. `updatedAt` is intentionally
 * omitted (`timestamps: { createdAt: true, updatedAt: false }`) — only membership
 * existence and inline `roles` are tracked; use an external audit log if mutation history
 * is needed.
 *
 * @example
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const GroupMembership = createGroupMembershipModel(conn, mongoose);
 * const memberships = await GroupMembership.find({ userId: 'user-123' });
 */
export function createGroupMembershipModel(
  conn: Connection,
  mongooseInstance: Mongoose,
): Model<GroupMembershipDocument> {
  if ('GroupMembership' in conn.models)
    return conn.models['GroupMembership'] as Model<GroupMembershipDocument>;

  const { Schema } = mongooseInstance;
  const schema = new Schema<GroupMembershipDocument>(
    {
      userId: { type: String, required: true },
      groupId: { type: String, required: true },
      roles: [{ type: String }],
      tenantId: { type: String, default: null },
    },
    { timestamps: { createdAt: true, updatedAt: false }, autoIndex: false },
  );

  schema.index({ userId: 1, groupId: 1 }, { unique: true });
  schema.index({ groupId: 1 });
  schema.index({ userId: 1, tenantId: 1 });

  return conn.model<GroupMembershipDocument>('GroupMembership', schema);
}
