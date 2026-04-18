import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import mongoose from 'mongoose';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { pushSubscriptionFactories } from '../../packages/slingshot-push/src/entities/factories';

const MONGO_URI = process.env.TEST_MONGO_URL ?? 'mongodb://localhost:27018/slingshot_test';

function createMongoInfra(conn: mongoose.Connection): StoreInfra {
  return {
    appName: 'slingshot-push-docker',
    getRedis() {
      throw new Error('redis not configured');
    },
    getMongo() {
      return { conn, mg: mongoose };
    },
    getSqliteDb() {
      throw new Error('sqlite not configured');
    },
    getPostgres() {
      throw new Error('postgres not configured');
    },
  };
}

describe('Push subscription mongo entity adapter (docker)', () => {
  let conn: mongoose.Connection;
  let adapter: Awaited<ReturnType<typeof pushSubscriptionFactories.mongo>>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(MONGO_URI).asPromise();
    adapter = await pushSubscriptionFactories.mongo(createMongoInfra(conn));
  });

  afterAll(async () => {
    await conn.close();
  });

  beforeEach(async () => {
    await adapter.clear();
  });

  test('upsertByDevice stores discriminated platform data', async () => {
    const saved = await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'ios-device',
      platform: 'ios',
      platformData: {
        platform: 'ios',
        deviceToken: 'token-1',
        bundleId: 'com.lastshotlabs.slingshot',
        environment: 'sandbox',
      },
    });

    expect(saved.platform).toBe('ios');
    expect(saved.platformData).toEqual({
      platform: 'ios',
      deviceToken: 'token-1',
      bundleId: 'com.lastshotlabs.slingshot',
      environment: 'sandbox',
    });

    const found = await adapter.findByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'ios-device',
    });
    expect(found?.id).toBe(saved.id);
  });

  test('listByUserId returns only the requested tenant records', async () => {
    await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-a',
      deviceId: 'device-a',
      platform: 'android',
      platformData: {
        platform: 'android',
        registrationToken: 'android-token-a',
        packageName: 'com.lastshotlabs.slingshot',
      },
    });
    await adapter.upsertByDevice({
      userId: 'user-1',
      tenantId: 'tenant-b',
      deviceId: 'device-b',
      platform: 'android',
      platformData: {
        platform: 'android',
        registrationToken: 'android-token-b',
        packageName: 'com.lastshotlabs.slingshot',
      },
    });

    const listed = await adapter.listByUserId({ userId: 'user-1', tenantId: 'tenant-a' });
    const items = Array.isArray(listed) ? listed : listed.items;

    expect(items).toHaveLength(1);
    expect(items[0]?.tenantId).toBe('tenant-a');
    expect(items[0]?.deviceId).toBe('device-a');
  });
});
