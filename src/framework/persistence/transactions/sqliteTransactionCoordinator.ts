import type { RuntimeSqliteDatabase, StoreInfra } from '@lastshotlabs/slingshot-core';
import type {
  FrameworkTransactionBackendProvider,
  FrameworkTransactionBackendSession,
} from './frameworkTransactionManager';

export const RUN_SQLITE_ENTITY_OPERATION = Symbol.for('slingshot.runSqliteEntityOperation');
export const SHUTDOWN_SQLITE_COORDINATOR = Symbol.for('slingshot.shutdownSqliteCoordinator');

interface Lease {
  release(): void;
}

interface Waiter {
  readonly resolve: (lease: Lease) => void;
  readonly reject: (error: Error) => void;
}

export interface SqliteTransactionCoordinator {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  acquire(): Promise<Lease>;
  shutdown(): void;
}

export class SqliteCoordinatorClosedError extends Error {
  override readonly name = 'SqliteCoordinatorClosedError';

  constructor() {
    super('[slingshot] SQLite operation coordinator is closed.');
  }
}

/** Create one FIFO operation coordinator for an application's shared SQLite handle. */
export function createSqliteTransactionCoordinator(): SqliteTransactionCoordinator {
  const waiters: Waiter[] = [];
  let owned = false;
  let closed = false;

  function createLease(): Lease {
    let released = false;
    return Object.freeze({
      release(): void {
        if (released) return;
        released = true;

        const next = waiters.shift();
        if (next) {
          next.resolve(createLease());
          return;
        }
        owned = false;
      },
    });
  }

  return Object.freeze({
    acquire(): Promise<Lease> {
      if (closed) {
        return Promise.reject(new SqliteCoordinatorClosedError());
      }
      if (!owned) {
        owned = true;
        return Promise.resolve(createLease());
      }
      return new Promise<Lease>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      const lease = await this.acquire();
      try {
        return await operation();
      } finally {
        lease.release();
      }
    },

    shutdown(): void {
      if (closed) return;
      closed = true;
      const error = new SqliteCoordinatorClosedError();
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
  });
}

function createScopedStoreInfra(baseInfra: StoreInfra, db: RuntimeSqliteDatabase): StoreInfra {
  const scopedInfra = Object.create(baseInfra) as StoreInfra;
  Object.defineProperties(scopedInfra, {
    getSqliteDb: {
      configurable: false,
      enumerable: true,
      writable: false,
      value: () => db,
    },
    [RUN_SQLITE_ENTITY_OPERATION]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: async <T>(operation: () => T | Promise<T>): Promise<T> => operation(),
    },
  });
  return Object.preventExtensions(scopedInfra);
}

export interface CreateSqliteTransactionProviderOptions {
  readonly db: RuntimeSqliteDatabase;
  readonly coordinator: SqliteTransactionCoordinator;
  readonly getStoreInfra: () => StoreInfra;
}

/** Create the SQLite provider that holds the global coordinator lease for one transaction. */
export function createSqliteTransactionProvider(
  options: CreateSqliteTransactionProviderOptions,
): FrameworkTransactionBackendProvider {
  return {
    store: 'sqlite',
    async open(): Promise<FrameworkTransactionBackendSession> {
      const lease = await options.coordinator.acquire();
      let released = false;
      try {
        options.db.run('BEGIN IMMEDIATE');
      } catch (error) {
        released = true;
        lease.release();
        throw error;
      }

      return {
        storeInfra: createScopedStoreInfra(options.getStoreInfra(), options.db),
        commit(): void {
          options.db.run('COMMIT');
          if (!released) {
            released = true;
            lease.release();
          }
        },
        rollback(): void {
          try {
            options.db.run('ROLLBACK');
          } finally {
            if (!released) {
              released = true;
              lease.release();
            }
          }
        },
        release(): void {
          if (released) return;
          released = true;
          lease.release();
        },
      };
    },
  };
}
