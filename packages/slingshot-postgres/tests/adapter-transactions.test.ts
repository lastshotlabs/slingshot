/**
 * Transaction tests for slingshot-postgres.
 *
 * Covers transaction-based adapter methods: setRoles, setTenantRoles,
 * setRecoveryCodes, listUsers, findOrCreateByProvider — verifying that
 * transactions are opened, operations are performed within them, and
 * errors propagate correctly.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createPostgresAdapter } from '../src/adapter.js';

// ── Mocks ─────────────────────────────────────────────────────────────────

let mockDbImpl: MockDb | null = null;
let mockMigrationVersion = 2;

interface MockDb {
  select?: () => Builder;
  insert?: (table?: unknown) => Builder;
  update?: (table?: unknown) => Builder;
  delete?: (table?: unknown) => Builder;
  transaction?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}

type Builder = Record<string, unknown> & PromiseLike<unknown>;

function makeBuilder(result: unknown, error: Error | null): Builder {
  const proxy: Builder = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          const p = error ? Promise.reject(error) : Promise.resolve(result);
          return p.then(f, r);
        };
      }
      return () => proxy;
    },
  }) as Builder;
  return proxy;
}

function resolvingBuilder(value: unknown): Builder {
  return makeBuilder(value, null);
}

function throwingBuilder(error: Error): Builder {
  return makeBuilder(null, error);
}

function transactionMock(
  selectValues: unknown[] = [],
): (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> {
  let idx = 0;
  const tx = {
    select: () => {
      const v = selectValues[Math.min(idx, selectValues.length - 1)] ?? [];
      idx++;
      return resolvingBuilder(v);
    },
    insert: () => resolvingBuilder(undefined),
    update: () => resolvingBuilder(undefined),
    delete: () => resolvingBuilder(undefined),
  };
  return async (fn: (tx: unknown) => Promise<unknown>) => fn(tx);
}

mock.module('pg', () => ({
  Pool: class MockPool {
    connect() {
      return Promise.resolve({
        query(sql: string) {
          if (sql.includes('SELECT COALESCE(MAX(version), 0) AS version')) {
            return Promise.resolve({ rows: [{ version: mockMigrationVersion }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release() {},
      });
    }
    end() {
      return Promise.resolve();
    }
  },
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (!mockDbImpl) throw new Error('mockDbImpl not set');
          const impl = mockDbImpl as Record<string | symbol, unknown>;
          if (prop in impl) return impl[prop];
          throw new Error(`mockDbImpl missing method: ${String(prop)}`);
        },
      },
    ),
}));

// ── Tests ─────────────────────────────────────────────────────────────────

describe('adapter-transactions — setRoles', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('setRoles calls transaction with delete + insert', async () => {
    let txCalled = false;
    mockDbImpl = {
      transaction: async fn => {
        txCalled = true;
        const tx = {
          delete: () => resolvingBuilder(undefined),
          insert: () => resolvingBuilder(undefined),
          select: () => resolvingBuilder(undefined),
          update: () => resolvingBuilder(undefined),
        };
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setRoles!('uid', ['admin', 'editor']);
    expect(txCalled).toBe(true);
  });

  test('setRoles throws when transaction fails', async () => {
    mockDbImpl = {
      transaction: async () => {
        throw new Error('deadlock');
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setRoles!('uid', ['admin'])).rejects.toThrow('deadlock');
  });
});

describe('adapter-transactions — setTenantRoles', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('setTenantRoles calls transaction and resolves', async () => {
    let txCalled = false;
    mockDbImpl = {
      transaction: async fn => {
        txCalled = true;
        const tx = {
          delete: () => resolvingBuilder(undefined),
          insert: () => resolvingBuilder(undefined),
          select: () => resolvingBuilder(undefined),
          update: () => resolvingBuilder(undefined),
        };
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setTenantRoles!('uid', 'tenant-1', ['member']);
    expect(txCalled).toBe(true);
  });

  test('setTenantRoles throws on transaction failure', async () => {
    mockDbImpl = {
      transaction: async () => {
        throw new Error('tx aborted');
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setTenantRoles!('uid', 't1', ['r1'])).rejects.toThrow('tx aborted');
  });
});

describe('adapter-transactions — setRecoveryCodes', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('setRecoveryCodes replaces codes atomically', async () => {
    let txCalled = false;
    mockDbImpl = {
      transaction: async fn => {
        txCalled = true;
        const tx = {
          delete: () => resolvingBuilder(undefined),
          insert: () => resolvingBuilder(undefined),
          select: () => resolvingBuilder(undefined),
          update: () => resolvingBuilder(undefined),
        };
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await adapter.setRecoveryCodes!('uid', ['hash1', 'hash2']);
    expect(txCalled).toBe(true);
  });

  test('setRecoveryCodes throws on transaction failure', async () => {
    mockDbImpl = {
      transaction: async () => {
        throw new Error('tx rollback');
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    await expect(adapter.setRecoveryCodes!('uid', ['h1'])).rejects.toThrow('tx rollback');
  });
});

describe('adapter-transactions — findOrCreateByProvider', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('findOrCreateByProvider uses transaction to create user atomically', async () => {
    let txCalled = false;
    let callCount = 0;
    mockDbImpl = {
      select: () => {
        callCount++;
        return callCount <= 2 ? resolvingBuilder([]) : resolvingBuilder([{ role: 'user' }]);
      },
      transaction: async fn => {
        txCalled = true;
        const tx = {
          select: () => resolvingBuilder([]),
          insert: () => resolvingBuilder(undefined),
          update: () => resolvingBuilder(undefined),
          delete: () => resolvingBuilder(undefined),
        };
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.findOrCreateByProvider!('google', 'g-1', {
      email: 'test@example.com',
    });
    expect(txCalled).toBe(true);
    expect(result.created).toBe(true);
  });
});

describe('adapter-transactions — listUsers', () => {
  beforeEach(() => {
    mockDbImpl = null;
    mockMigrationVersion = 2;
  });

  test('listUsers uses transaction for count + user query', async () => {
    let txCalled = false;
    mockDbImpl = {
      transaction: async fn => {
        txCalled = true;
        const tx = {
          select: () => resolvingBuilder([{ count: '3' }]),
          insert: () => resolvingBuilder(undefined),
          update: () => resolvingBuilder(undefined),
          delete: () => resolvingBuilder(undefined),
        };
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.listUsers!({});
    expect(txCalled).toBe(true);
    expect(result.totalResults).toBe(3);
  });

  test('listUsers with suspended filter works', async () => {
    mockDbImpl = {
      transaction: async fn => {
        const tx = {
          select: () => resolvingBuilder([{ count: '1' }, { id: 'u1', email: 'u@e.com' }]),
          insert: () => resolvingBuilder(undefined),
          update: () => resolvingBuilder(undefined),
          delete: () => resolvingBuilder(undefined),
        };
        return fn(tx);
      },
    };
    const adapter = await createPostgresAdapter({ pool: new (await import('pg')).Pool() });
    const result = await adapter.listUsers!({ suspended: true });
    expect(result.totalResults).toBe(1);
  });
});
