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

/**
 * Configuration for creating an audit log provider.
 */
export interface AuditLogOptions {
  /** Persistence backend for audit log entries. */
  store: AuditLogStore;
  /** SQLite database instance (required when `store` is `'sqlite'`). */
  db?: RuntimeSqliteDatabase;
  /** MongoDB connection (required when `store` is `'mongo'`). */
  mongoConnection?: Connection | null;
  /** Retention in days. SQLite: prunes on write. MongoDB: sets expiresAt for the TTL index. */
  ttlDays?: number;
  /** Emit non-fatal provider warnings such as in-memory caveats. Defaults to true. */
  emitWarnings?: boolean;
}

/**
 * Query parameters for retrieving audit log entries.
 */
export interface AuditLogQuery {
  /** Filter entries by acting user ID. */
  userId?: string;
  /** Filter entries by tenant ID. */
  tenantId?: string;
  /** Return entries after this date. */
  after?: Date | string;
  /** Return entries before this date. */
  before?: Date | string;
  /** Maximum number of entries to return. */
  limit?: number;
  /** Opaque cursor for pagination. */
  cursor?: string;
}

/**
 * Create an {@link AuditLogProvider} for the configured storage backend.
 *
 * @param options - Storage backend selection and connection details.
 * @returns An audit log provider instance.
 * @throws When the required connection for the selected store is not provided.
 */
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
