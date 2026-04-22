import { getMongooseModule } from '@lib/mongo';
import type { Connection, Document, Model } from 'mongoose';

// ---------------------------------------------------------------------------
// Tenant record schema (stored in auth database)
// ---------------------------------------------------------------------------

/**
 * Read-only representation of a tenant record.
 */
export interface TenantInfo {
  /** Unique tenant identifier. */
  tenantId: string;
  /** Human-readable tenant name. */
  displayName?: string;
  /** Arbitrary per-tenant configuration data. */
  config?: Record<string, unknown>;
  /** Timestamp when the tenant was first created. */
  createdAt: Date;
  /** Soft-delete timestamp, or `null` when the tenant is active. */
  deletedAt?: Date | null;
}

interface ITenantDoc {
  tenantId: string;
  displayName?: string;
  config?: Record<string, unknown>;
  deletedAt?: Date | null;
}

type TenantDocument = ITenantDoc & Document;
type LeanTenantRecord = ITenantDoc & { createdAt: Date };

function getTenantModel(conn: Connection) {
  if (Object.hasOwn(conn.models, 'Tenant')) {
    return conn.models['Tenant'] as Model<TenantDocument>;
  }
  const mg = getMongooseModule();
  const { Schema } = mg;
  const schema = new Schema<TenantDocument>(
    {
      tenantId: { type: String, required: true, unique: true },
      displayName: { type: String },
      config: { type: Schema.Types.Mixed },
      deletedAt: { type: Date, default: null },
    },
    { timestamps: true },
  );
  return conn.model<TenantDocument>('Tenant', schema);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for creating a new tenant.
 */
export interface CreateTenantOptions {
  /** Human-readable display name for the tenant. */
  displayName?: string;
  /** Arbitrary per-tenant configuration data. */
  config?: Record<string, unknown>;
}

/**
 * CRUD service for managing tenant records.
 *
 * Supports creation, soft-deletion (with reactivation), lookup, and listing.
 */
export interface TenantService {
  /** Create a new tenant. Reactivates a soft-deleted tenant with the same ID. */
  createTenant(tenantId: string, options?: CreateTenantOptions): Promise<void>;
  /** Soft-delete a tenant and invalidate its resolution cache entry. */
  deleteTenant(tenantId: string): Promise<void>;
  /** Retrieve a tenant by ID, or `null` if not found or soft-deleted. */
  getTenant(tenantId: string): Promise<TenantInfo | null>;
  /** List all active (non-deleted) tenants. */
  listTenants(): Promise<TenantInfo[]>;
}

/**
 * Create a {@link TenantService} backed by a Mongoose connection.
 *
 * @param conn - The MongoDB connection to use for tenant storage.
 * @param getTenantCache - Optional getter for the tenant resolution cache,
 *   used to invalidate entries on deletion.
 * @returns A tenant service instance.
 */
export function createTenantService(
  conn: Connection,
  getTenantCache?: () => { delete(tenantId: string): void } | null,
): TenantService {
  return {
    async createTenant(tenantId: string, options?: CreateTenantOptions): Promise<void> {
      const Tenant = getTenantModel(conn);
      const existing = await Tenant.findOne({ tenantId }).lean();
      if (existing && !existing.deletedAt) {
        throw new Error(`Tenant "${tenantId}" already exists`);
      }
      if (existing && existing.deletedAt) {
        // Reactivate soft-deleted tenant
        await Tenant.findOneAndUpdate(
          { tenantId },
          { $set: { deletedAt: null, displayName: options?.displayName, config: options?.config } },
        );
        return;
      }
      await Tenant.create({
        tenantId,
        displayName: options?.displayName,
        config: options?.config,
      });
    },

    async deleteTenant(tenantId: string): Promise<void> {
      const Tenant = getTenantModel(conn);
      const existing = await Tenant.findOne({ tenantId }).lean();
      // Already deleted (or never existed) — nothing to do
      if (!existing || existing.deletedAt) return;
      // Soft-delete
      await Tenant.findOneAndUpdate({ tenantId }, { $set: { deletedAt: new Date() } });
      const cache = getTenantCache?.();
      if (cache) cache.delete(tenantId);
    },

    async getTenant(tenantId: string): Promise<TenantInfo | null> {
      const Tenant = getTenantModel(conn);
      const doc = await Tenant.findOne({ tenantId, deletedAt: null }).lean<LeanTenantRecord>();
      if (!doc) return null;
      return {
        tenantId: doc.tenantId,
        displayName: doc.displayName,
        config: doc.config,
        createdAt: doc.createdAt,
      };
    },

    async listTenants(): Promise<TenantInfo[]> {
      const Tenant = getTenantModel(conn);
      const docs = await Tenant.find({ deletedAt: null }).lean<LeanTenantRecord[]>();
      return docs.map(doc => ({
        tenantId: doc.tenantId,
        displayName: doc.displayName,
        config: doc.config,
        createdAt: doc.createdAt,
      }));
    },
  };
}
