import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { RuntimeSqliteDatabase } from '@lastshotlabs/slingshot-core';
import {
  createMemoryProviderConnectionStore,
  createSqliteProviderConnectionStore,
} from '../../src/lib/providerConnections';
import type { ProviderConnectionStore } from '../../src/lib/providerConnections';

function sqliteStore() {
  const db = new Database(':memory:') as unknown as RuntimeSqliteDatabase;
  return createSqliteProviderConnectionStore(db);
}

const BACKENDS: Array<[string, () => ProviderConnectionStore]> = [
  ['memory', createMemoryProviderConnectionStore],
  ['sqlite', sqliteStore],
];

const base = {
  userId: 'user-1',
  provider: 'spotify',
  providerUserId: 'spotify-user-1',
  scopes: ['streaming', 'user-read-email'],
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: Date.now() + 3600_000,
};

describe.each(BACKENDS)('ProviderConnectionStore (%s)', (_name, makeStore) => {
  test('get returns null for a missing connection', async () => {
    const store = makeStore();
    expect(await store.get('nobody', 'spotify')).toBeNull();
  });

  test('upsert creates and round-trips all fields including scopes', async () => {
    const store = makeStore();
    const created = await store.upsert(base);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBeGreaterThan(0);

    const fetched = await store.get('user-1', 'spotify');
    expect(fetched).not.toBeNull();
    expect(fetched!.providerUserId).toBe('spotify-user-1');
    expect(fetched!.scopes).toEqual(['streaming', 'user-read-email']);
    expect(fetched!.accessToken).toBe('access-1');
    expect(fetched!.refreshToken).toBe('refresh-1');
    expect(fetched!.accessTokenExpiresAt).toBe(base.accessTokenExpiresAt);
  });

  test('upsert replaces tokens on re-consent and preserves createdAt', async () => {
    const store = makeStore();
    const created = await store.upsert(base);
    await new Promise(resolve => setTimeout(resolve, 5));
    const updated = await store.upsert({
      ...base,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      scopes: ['streaming'],
    });
    expect(updated.accessToken).toBe('access-2');
    expect(updated.refreshToken).toBe('refresh-2');
    expect(updated.scopes).toEqual(['streaming']);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    // Still exactly one row for the (user, provider) pair.
    expect(await store.listByUser('user-1')).toHaveLength(1);
  });

  test('listByUser returns only that user’s connections', async () => {
    const store = makeStore();
    await store.upsert(base);
    await store.upsert({ ...base, provider: 'google', providerUserId: 'g-1' });
    await store.upsert({ ...base, userId: 'user-2', providerUserId: 'other' });

    const list = await store.listByUser('user-1');
    expect(list.map(c => c.provider).sort()).toEqual(['google', 'spotify']);
    expect(list.every(c => c.userId === 'user-1')).toBe(true);
  });

  test('delete removes the connection and reports absence', async () => {
    const store = makeStore();
    await store.upsert(base);
    expect(await store.delete('user-1', 'spotify')).toBe(true);
    expect(await store.get('user-1', 'spotify')).toBeNull();
    expect(await store.delete('user-1', 'spotify')).toBe(false);
  });
});

test('sqlite schema init is idempotent across store instances on one db', async () => {
  const db = new Database(':memory:') as unknown as RuntimeSqliteDatabase;
  const first = createSqliteProviderConnectionStore(db);
  await first.upsert(base);
  // A second store over the same handle re-runs CREATE TABLE IF NOT EXISTS.
  const second = createSqliteProviderConnectionStore(db);
  const fetched = await second.get('user-1', 'spotify');
  expect(fetched?.accessToken).toBe('access-1');
});
