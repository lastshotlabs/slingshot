import type { PostgresBundle, StoreInfra } from '@lastshotlabs/slingshot-core';
import type {
  FrameworkTransactionBackendProvider,
  FrameworkTransactionBackendSession,
} from './frameworkTransactionManager';

const CREATE_POSTGRES_SCOPED_BUNDLE = Symbol.for('slingshot.createPostgresScopedBundle');
const SCOPED_POSTGRES_QUERYABLE = Symbol.for('slingshot.scopedPostgresQueryable');

interface QueryResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number | null;
}

interface PostgresQueryable {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

interface PostgresClient extends PostgresQueryable {
  release(): void;
}

interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
}

type ScopedBundleFactory = (queryable: object) => PostgresBundle;

export interface CreatePostgresTransactionProviderOptions {
  readonly postgres: PostgresBundle;
  readonly getStoreInfra: () => StoreInfra;
}

function createScopedStoreInfra(baseInfra: StoreInfra, postgres: PostgresBundle): StoreInfra {
  const scopedInfra = Object.create(baseInfra) as StoreInfra;
  Object.defineProperty(scopedInfra, 'getPostgres', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () => postgres,
  });
  return Object.preventExtensions(scopedInfra);
}

/**
 * Create the framework PostgreSQL provider.
 *
 * One pool client is checked out and begun before the manager publishes a scope.
 * Scoped repositories receive a query-only facade over that client, so all work
 * stays on the same physical connection without exposing checkout or release.
 */
export function createPostgresTransactionProvider(
  options: CreatePostgresTransactionProviderOptions,
): FrameworkTransactionBackendProvider {
  return {
    store: 'postgres',
    async open(): Promise<FrameworkTransactionBackendSession> {
      const pool = options.postgres.pool as unknown as PostgresPool;
      const client = await pool.connect();
      let released = false;
      let rollbackOnly = false;
      let rollbackOnlyError: unknown;

      try {
        await client.query('BEGIN');
      } catch (error) {
        released = true;
        try {
          client.release();
        } catch {
          // Preserve the BEGIN failure.
        }
        throw error;
      }

      const queryable: PostgresQueryable & { readonly [SCOPED_POSTGRES_QUERYABLE]: true } =
        Object.freeze({
          [SCOPED_POSTGRES_QUERYABLE]: true as const,
          async query(sql: string, params?: unknown[]): Promise<QueryResult> {
            try {
              return await client.query(sql, params);
            } catch (error) {
              rollbackOnly = true;
              rollbackOnlyError ??= error;
              throw error;
            }
          },
        });

      const createScopedBundle = Reflect.get(options.postgres, CREATE_POSTGRES_SCOPED_BUNDLE) as
        | ScopedBundleFactory
        | undefined;
      const scopedPostgres =
        typeof createScopedBundle === 'function'
          ? createScopedBundle.call(options.postgres, queryable)
          : ({
              ...options.postgres,
              pool: queryable,
            } as unknown as PostgresBundle);
      const scopedInfra = createScopedStoreInfra(options.getStoreInfra(), scopedPostgres);

      return {
        storeInfra: scopedInfra,
        async commit(): Promise<void> {
          await client.query('COMMIT');
        },
        async rollback(): Promise<void> {
          await client.query('ROLLBACK');
        },
        release(): void {
          if (released) return;
          released = true;
          client.release();
        },
        rollbackOnlyCause(): { readonly cause: unknown } | null {
          return rollbackOnly ? { cause: rollbackOnlyError } : null;
        },
      };
    },
  };
}
