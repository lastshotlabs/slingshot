import { describe, expect, test } from 'bun:test';
import {
  RESOLVE_TRANSACTION_ENTITY_ADAPTER,
  type StoreInfra,
  TransactionCommitError,
  type TransactionManager,
  TransactionPostCommitError,
  type TransactionScope,
  TransactionScopeClosedError,
  TransactionScopeInvalidError,
  TransactionScopeMismatchError,
  TransactionStoreUnsupportedError,
  UnsettledTransactionWorkError,
  buildHookServices,
  createInProcessAdapter,
  noopLogger,
} from '@lastshotlabs/slingshot-core';
import {
  type FrameworkTransactionBackendSession,
  type FrameworkTransactionManager,
  createFrameworkTransactionManager,
} from '../../src/framework/persistence/transactions/frameworkTransactionManager';

const RESOLVE_SEARCH_SYNC = Symbol.for('slingshot.resolveSearchSync');

function unavailable(store: string): never {
  throw new Error(`${store} is unavailable in the transaction-manager fixture`);
}

function createHarness(options?: {
  readonly commit?: () => void | Promise<void>;
  readonly rollback?: () => void | Promise<void>;
  readonly release?: () => void | Promise<void>;
  readonly searchSync?: () => unknown;
}) {
  const events: string[] = [];
  let opens = 0;
  const infra: StoreInfra & { [RESOLVE_SEARCH_SYNC]?: () => unknown } = {
    appName: 'transaction-manager-test',
    getTransactions: () => manager,
    getRedis: () => unavailable('Redis'),
    getMongo: () => unavailable('MongoDB'),
    getSqliteDb: () => unavailable('SQLite'),
    getPostgres: () => unavailable('PostgreSQL'),
  };
  if (options?.searchSync) {
    Object.defineProperty(infra, RESOLVE_SEARCH_SYNC, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: options.searchSync,
    });
  }

  const manager = createFrameworkTransactionManager([
    {
      store: 'postgres',
      open(): FrameworkTransactionBackendSession {
        opens += 1;
        events.push('open');
        return {
          storeInfra: infra,
          async commit() {
            events.push('commit');
            await options?.commit?.();
          },
          async rollback() {
            events.push('rollback');
            await options?.rollback?.();
          },
          async release() {
            events.push('release');
            await options?.release?.();
          },
        };
      },
    },
  ]);

  return {
    events,
    get opens() {
      return opens;
    },
    infra,
    manager,
  };
}

function registerAdapter(
  manager: FrameworkTransactionManager,
  buildAdapter: (infra: StoreInfra) => object,
  store: 'postgres' | 'sqlite' = 'postgres',
): void {
  manager.registerEntity({
    plugin: 'notes',
    entity: 'Note',
    store,
    buildAdapter,
  });
}

describe('framework transaction manager', () => {
  test('rejects unsupported stores before opening backend infrastructure', async () => {
    const harness = createHarness();

    expect(harness.manager.supports('postgres')).toBe(true);
    expect(harness.manager.supports('sqlite')).toBe(false);
    await expect(
      harness.manager.run('sqlite', async () => {
        throw new Error('unreachable');
      }),
    ).rejects.toBeInstanceOf(TransactionStoreUnsupportedError);
    expect(harness.opens).toBe(0);
  });

  test('reuses the exact scope for same-store nesting and rejects cross-store nesting', async () => {
    const harness = createHarness();
    let outerScope: TransactionScope | undefined;
    let nestedScope: TransactionScope | undefined;

    await harness.manager.run('postgres', async scope => {
      outerScope = scope;
      await harness.manager.run('postgres', inner => {
        nestedScope = inner;
      });
      await expect(harness.manager.run('sqlite', async () => undefined)).rejects.toBeInstanceOf(
        TransactionScopeMismatchError,
      );
    });

    expect(nestedScope).toBe(outerScope);
    expect(harness.opens).toBe(1);
    expect(harness.events).toEqual(['open', 'commit', 'release']);
  });

  test('caches scoped adapters and closes retained adapters before later I/O', async () => {
    const harness = createHarness();
    let calls = 0;
    registerAdapter(harness.manager, () => ({
      async getById(id: string) {
        calls += 1;
        return { id };
      },
    }));

    const retained = await harness.manager.run('postgres', async scope => {
      const first = harness.manager.resolveEntity({
        plugin: 'notes',
        entity: 'Note',
        scope,
      }) as { getById(id: string): Promise<unknown> };
      const second = harness.manager.resolveEntity({
        plugin: 'notes',
        entity: 'Note',
        scope,
      });
      expect(second).toBe(first);
      await first.getById('n1');
      return first;
    });

    expect(calls).toBe(1);
    expect(() => retained.getById('n2')).toThrow(TransactionScopeClosedError);
    expect(calls).toBe(1);
  });

  test('rejects forged, foreign-manager, and wrong-store scopes before adapter construction', async () => {
    const first = createHarness();
    const second = createHarness();
    let builds = 0;
    registerAdapter(first.manager, () => {
      builds += 1;
      return {};
    });
    registerAdapter(second.manager, () => ({}));

    // The public brand is intentionally unavailable; this assertion models untyped input.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const forgedScope = { store: 'postgres', id: 'forged' } as TransactionScope;
    expect(() =>
      first.manager.resolveEntity({
        plugin: 'notes',
        entity: 'Note',
        scope: forgedScope,
      }),
    ).toThrow(TransactionScopeInvalidError);

    await first.manager.run('postgres', async scope => {
      expect(() =>
        second.manager.resolveEntity({
          plugin: 'notes',
          entity: 'Note',
          scope,
        }),
      ).toThrow(TransactionScopeInvalidError);
    });

    const mismatch = createHarness();
    registerAdapter(
      mismatch.manager,
      () => {
        builds += 1;
        return {};
      },
      'sqlite',
    );
    await expect(
      mismatch.manager.run('postgres', async scope => {
        mismatch.manager.resolveEntity({
          plugin: 'notes',
          entity: 'Note',
          scope,
        });
      }),
    ).rejects.toBeInstanceOf(TransactionScopeMismatchError);
    expect(builds).toBe(0);
  });

  test('waits for pending scoped work, rolls back, and reports unsettled work', async () => {
    const harness = createHarness();
    let finish: (() => void) | undefined;
    registerAdapter(harness.manager, () => ({
      write() {
        return new Promise<void>(resolve => {
          finish = resolve;
        });
      },
    }));

    const result = harness.manager.run('postgres', scope => {
      const adapter = harness.manager.resolveEntity({
        plugin: 'notes',
        entity: 'Note',
        scope,
      }) as { write(): Promise<void> };
      void adapter.write();
      return 'returned-too-early';
    });

    await Promise.resolve();
    finish?.();
    await expect(result).rejects.toBeInstanceOf(UnsettledTransactionWorkError);
    expect(harness.events).toEqual(['open', 'rollback', 'release']);
  });

  test('does not ambiently rebind or track an adapter resolved outside the scope', async () => {
    const harness = createHarness();
    let finish: (() => void) | undefined;
    const unscopedAdapter = {
      write() {
        return new Promise<void>(resolve => {
          finish = resolve;
        });
      },
    };

    await harness.manager.run('postgres', () => {
      void unscopedAdapter.write();
      return 'commits-with-outside-work-pending';
    });

    expect(harness.events).toEqual(['open', 'commit', 'release']);
    finish?.();
  });

  test('rejects detached adapter work after the callback closes', async () => {
    const harness = createHarness();
    let calls = 0;
    let observeLateError: Promise<unknown> | undefined;
    registerAdapter(harness.manager, () => ({
      async write() {
        calls += 1;
      },
    }));

    await harness.manager.run('postgres', scope => {
      const adapter = harness.manager.resolveEntity({
        plugin: 'notes',
        entity: 'Note',
        scope,
      }) as { write(): Promise<void> };
      observeLateError = new Promise(resolve => {
        setTimeout(() => {
          try {
            void adapter.write();
          } catch (error) {
            resolve(error);
          }
        }, 0);
      });
    });

    await expect(observeLateError).resolves.toBeInstanceOf(TransactionScopeClosedError);
    expect(calls).toBe(0);
  });

  test('preserves callback errors when rollback also fails', async () => {
    const primary = new Error('callback failed');
    const harness = createHarness({
      rollback: () => {
        throw new Error('rollback failed');
      },
    });

    await expect(
      harness.manager.run('postgres', async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(harness.events).toEqual(['open', 'rollback', 'release']);
  });

  test('reports commit outcome and releases the backend after a commit failure', async () => {
    const harness = createHarness({
      commit: () => {
        throw new Error('commit failed');
      },
    });

    let error: unknown;
    try {
      await harness.manager.run('postgres', async () => 'value');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TransactionCommitError);
    expect((error as TransactionCommitError).outcome).toBe('rolled_back');
    expect(harness.events).toEqual(['open', 'commit', 'rollback', 'release']);
  });

  test('buffers framework search effects until commit and runs them in order', async () => {
    const harness = createHarness({
      searchSync: () => ({
        syncMode: 'write-through',
        ensureReady: async () => {
          harness.events.push('search:ready');
        },
        indexDocument: async () => {
          harness.events.push('search:index');
        },
        deleteDocument: async () => {
          harness.events.push('search:delete');
        },
      }),
    });
    registerAdapter(harness.manager, infra => {
      const resolveSync = Reflect.get(infra, RESOLVE_SEARCH_SYNC) as (config: unknown) => {
        indexDocument(entity: Record<string, unknown>): Promise<void>;
      };
      const sync = resolveSync({ _storageName: 'notes' });
      return {
        async create() {
          harness.events.push('adapter:create');
          await sync.indexDocument({ id: 'n1' });
          return { id: 'n1' };
        },
      };
    });

    await harness.manager.run('postgres', async scope => {
      const adapter = harness.manager.resolveEntity({
        plugin: 'notes',
        entity: 'Note',
        scope,
      }) as { create(): Promise<unknown> };
      await adapter.create();
      expect(harness.events).toEqual(['open', 'adapter:create']);
    });

    expect(harness.events).toEqual([
      'open',
      'adapter:create',
      'commit',
      'search:ready',
      'search:index',
      'release',
    ]);
  });

  test('labels post-commit effect failures without claiming rollback', async () => {
    const harness = createHarness({
      searchSync: () => ({
        syncMode: 'write-through',
        ensureReady: async () => {},
        indexDocument: async () => {
          throw new Error('search unavailable');
        },
        deleteDocument: async () => {},
      }),
    });
    registerAdapter(harness.manager, infra => {
      const resolveSync = Reflect.get(infra, RESOLVE_SEARCH_SYNC) as (config: unknown) => {
        indexDocument(entity: Record<string, unknown>): Promise<void>;
      };
      const sync = resolveSync({ _storageName: 'notes' });
      return {
        async create() {
          await sync.indexDocument({ id: 'n1' });
        },
      };
    });

    let error: unknown;
    try {
      await harness.manager.run('postgres', async scope => {
        const adapter = harness.manager.resolveEntity({
          plugin: 'notes',
          entity: 'Note',
          scope,
        }) as { create(): Promise<void> };
        await adapter.create();
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TransactionPostCommitError);
    expect((error as TransactionPostCommitError).committed).toBe(true);
    expect((error as TransactionPostCommitError).failures).toEqual([
      { effect: 'notes:search:index', message: 'search unavailable' },
    ]);
    expect(harness.events).toEqual(['open', 'commit', 'release']);
  });

  test('publishes the internal resolver only as a non-enumerable manager hook', () => {
    const harness = createHarness();
    expect(Reflect.get(harness.manager, RESOLVE_TRANSACTION_ENTITY_ADAPTER)).toBeInstanceOf(
      Function,
    );
    expect(Object.keys(harness.manager)).not.toContain(String(RESOLVE_TRANSACTION_ENTITY_ADAPTER));
    expect(harness.infra.getTransactions()).toBe(harness.manager as TransactionManager);
  });

  test('hook services expose the explicitly supplied app manager unchanged', () => {
    const harness = createHarness();
    const services = buildHookServices({
      app: {},
      pluginState: new Map(),
      bus: createInProcessAdapter(),
      logger: noopLogger,
      pluginName: 'notes',
      transactions: harness.manager,
    });

    expect(services.transactions).toBe(harness.manager);
  });
});
