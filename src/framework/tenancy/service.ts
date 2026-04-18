import { getMongooseModule } from '@lib/mongo';
import type { Connection, Document, Model } from 'mongoose';

// ---------------------------------------------------------------------------
// Tenant record schema (stored in auth database)
// ---------------------------------------------------------------------------

export interface TenantInfo {
  tenantId: string;
  displayName?: string;
  config?: Record<string, unknown>;
  createdAt: Date;
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

export interface CreateTenantOptions {
  displayName?: string;
  config?: Record<string, unknown>;
}

export interface TenantService {
  createTenant(tenantId: string, options?: CreateTenantOptions): Promise<void>;
  deleteTenant(tenantId: string): Promise<void>;
  getTenant(tenantId: string): Promise<TenantInfo | null>;
  listTenants(): Promise<TenantInfo[]>;
}

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
