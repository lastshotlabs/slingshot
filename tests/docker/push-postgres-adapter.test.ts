import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { pushSubscriptionFactories } from '../../packages/slingshot-push/src/entities/factories';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

function createPostgresInfra(pool: Pool): StoreInfra {
  return {
    appName: 'slingshot-push-docker',
    getRedis() {
      throw new Error('redis not configured');
    },
    getMongo() {
      throw new Error('mongo not configured');
    },
    getSqliteDb() {
      throw new Error('sqlite not configured');
    },
    getPostgres() {
      return { pool, db: null };
    },
  };
}

describe('Push subscription postgres entity adapter (docker)', () => {
  let pool: Pool;
  let adapter: Awaited<ReturnType<typeof pushSubscriptionFactories.postgres>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    adapter = await pushSubscriptionFactories.postgres(createPostgresInfra(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await adapter.clear();
  });

  test('upsertByDevice creates and updates a unified subscription record', async () => {
    const first = await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'device-1',
      platform: 'web',
      platformData: {
        platform: 'web',
        endpoint: 'https://push.example.com/sub-1',
        keys: { p256dh: 'old-key', auth: 'old-auth' },
      },
    });
    const second = await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'device-1',
      platform: 'web',
      platformData: {
        platform: 'web',
        endpoint: 'https://push.example.com/sub-1',
        keys: { p256dh: 'new-key', auth: 'new-auth' },
      },
    });

    expect(second.id).toBe(first.id);
    expect(second.platformData).toEqual({
      platform: 'web',
      endpoint: 'https://push.example.com/sub-1',
      keys: { p256dh: 'new-key', auth: 'new-auth' },
    });

    const listed = await adapter.listByUserId({ userId: 'user-1', tenantId: 'tenant-a' });
    const items = Array.isArray(listed) ? listed : listed.items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(first.id);
  });

  test('findByDevice is tenant-scoped', async () => {
    await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'shared-device',
      platform: 'web',
      platformData: {
        platform: 'web',
        endpoint: 'https://push.example.com/a',
        keys: { p256dh: 'key-a', auth: 'auth-a' },
      },
    });
    await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-b',
      deviceId: 'shared-device',
      platform: 'web',
      platformData: {
        platform: 'web',
        endpoint: 'https://push.example.com/b',
        keys: { p256dh: 'key-b', auth: 'auth-b' },
      },
    });

    const tenantA = await adapter.findByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'shared-device',
    });
    const tenantB = await adapter.findByDevice({
      userId: 'user-1',
      tenantId: 'tenant-b',
      deviceId: 'shared-device',
    });

    expect(tenantA?.tenantId).toBe('tenant-a');
    expect(tenantB?.tenantId).toBe('tenant-b');
    expect(tenantA?.id).not.toBe(tenantB?.id);
  });
});
