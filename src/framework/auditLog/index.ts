import type { Connection } from 'mongoose';
import type {
  AuditLogProvider,
  RepoFactories,
  RuntimeSqliteDatabase,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { createMemoryAuditLogProvider } from './memoryProvider';
import { createMongoAuditLogProvider } from './mongoProvider';
import { createPostgresAuditLogProvider } from './postgresProvider';
import { createSqliteAuditLogProvider } from './sqliteProvider';

export type AuditLogStore = Exclude<StoreType, 'redis'>;
export interface AuditLogProviderFactoryOptions {
  emitWarnings?: boolean;
}

export interface AuditLogOptions {
  store: AuditLogStore;
  db?: RuntimeSqliteDatabase;
  mongoConnection?: Connection | null;
  /** Retention in days. SQLite: prunes on write. MongoDB: sets expiresAt for the TTL index. */
  ttlDays?: number;
  /** Emit non-fatal provider warnings such as in-memory caveats. Defaults to true. */
  emitWarnings?: boolean;
}

export interface AuditLogQuery {
  userId?: string;
  tenantId?: string;
  after?: Date | string;
  before?: Date | string;
  limit?: number;
  cursor?: string;
}

export function createAuditLogProvider(options: AuditLogOptions): AuditLogProvider {
  const providers: Record<AuditLogStore, () => AuditLogProvider> = {
    memory: () => createMemoryAuditLogProvider({ emitWarnings: options.emitWarnings }),
    sqlite: () => {
      if (!options.db)
        throw new Error("AuditLog: store is 'sqlite' but no db instance was provided");
      return createSqliteAuditLogProvider(options.db, options.ttlDays);
    },
    mongo: () => {
      if (!options.mongoConnection)
        throw new Error("AuditLog: store is 'mongo' but no connection was provided");
      return createMongoAuditLogProvider(options.mongoConnection, options.ttlDays);
    },
    postgres: () => {
      throw new Error(
        'AuditLog: use createAuditLogFactories() instead of createAuditLogProvider() for postgres',
      );
    },
  };

  return providers[options.store]();
}

export function createAuditLogFactories(
  ttlDays?: number,
  options: AuditLogProviderFactoryOptions = {},
): RepoFactories<AuditLogProvider> {
  return {
    memory: () => createMemoryAuditLogProvider(options),
    sqlite: infra => createSqliteAuditLogProvider(infra.getSqliteDb(), ttlDays),
    redis: () => createMemoryAuditLogProvider(options),
    mongo: infra => createMongoAuditLogProvider(infra.getMongo().conn, ttlDays),
    postgres: infra => createPostgresAuditLogProvider(infra.getPostgres().pool, ttlDays),
  };
}

/** @deprecated Use createAuditLogFactories() instead. */
export const auditLogFactories: RepoFactories<AuditLogProvider> = createAuditLogFactories();
