import { getMongooseModule } from '@lib/mongo';
import type { Connection, Document, Model } from 'mongoose';

/**
 * Shape of a single audit log document stored in the `audit_logs` collection.
 *
 * Every HTTP request handled by the audit middleware produces one document.
 * Fields marked optional (`action`, `resource`, `resourceId`, `meta`, `expiresAt`)
 * are populated by higher-level helpers that have semantic context about the
 * operation being audited.
 */
interface IAuditLog {
  id: string;
  userId: string | null;
  sessionId: string | null;
  tenantId: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  userAgent: string | null;
  action?: string;
  resource?: string;
  resourceId?: string;
  meta?: Record<string, unknown>;
  createdAt: Date;
  expiresAt?: Date;
}

type AuditLogDocument = IAuditLog & Document;

/**
 * Retrieve (or lazily register) the Mongoose `AuditLog` model on a connection.
 *
 * Uses Mongoose's model cache (`conn.models['AuditLog']`) so the schema is only
 * compiled once per connection — safe to call multiple times. The schema includes:
 *
 * - A MongoDB TTL index on `expiresAt` (`expireAfterSeconds: 0`) for automatic
 *   document expiry. Set `expiresAt` when creating a log entry to schedule deletion.
 * - Compound indexes on `(userId, createdAt)` and `(tenantId, createdAt)` to
 *   support the most common query patterns efficiently.
 * - A single-field index on `path` for per-route audit queries.
 * - `timestamps: { createdAt: 'createdAt', updatedAt: false }` — creation time
 *   only; audit logs are immutable after creation.
 *
 * @param conn - Mongoose `Connection` to register the model on. Pass the app
 *   Mongo connection from `getMongoFromApp(app).appConn`.
 * @returns The `AuditLog` Mongoose model bound to `conn`.
 *
 * @example
 * ```ts
 * const AuditLog = getAuditLogModel(appConn);
 * await AuditLog.create({ id: crypto.randomUUID(), method: 'POST', path: '/users', status: 201, ... });
 * ```
 */
export function getAuditLogModel(conn: Connection): Model<AuditLogDocument> {
  if (Object.hasOwn(conn.models, 'AuditLog')) {
    return conn.models['AuditLog'] as Model<AuditLogDocument>;
  }

  const mg = getMongooseModule();
  const { Schema } = mg;
  const schema = new Schema<AuditLogDocument>(
    {
      id: { type: String, required: true, unique: true },
      userId: { type: String, default: null },
      sessionId: { type: String, default: null },
      tenantId: { type: String, default: null },
      method: { type: String, required: true },
      path: { type: String, required: true },
      status: { type: Number, required: true },
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      action: { type: String },
      resource: { type: String },
      resourceId: { type: String },
      meta: { type: Schema.Types.Mixed },
      expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
    },
    {
      collection: 'audit_logs',
      timestamps: { createdAt: 'createdAt', updatedAt: false },
    },
  );

  schema.index({ userId: 1, createdAt: 1 });
  schema.index({ tenantId: 1, createdAt: 1 });
  schema.index({ path: 1 });

  return conn.model<AuditLogDocument>('AuditLog', schema);
}
