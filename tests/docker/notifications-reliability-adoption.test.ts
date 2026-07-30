import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Pool } from 'pg';
import { createBullMQAdapter } from '@lastshotlabs/slingshot-bullmq';
import { getContext, resolveCapabilityValue } from '@lastshotlabs/slingshot-core';
import {
  NotificationsBuilderFactoryCap,
  NotificationsDeliveryRegistryCap,
  createNotificationsPackage,
} from '@lastshotlabs/slingshot-notifications';
import { createTestApp } from '../setup';

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

describe('notifications production reliability adoption', () => {
  const schema = `notifications_reliability_${randomUUID().replaceAll('-', '_')}`;
  const admin = new Pool({ connectionString: POSTGRES_URL });
  let scopedUrl: string;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(POSTGRES_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl = url.toString();
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test('commits notification plus outbox and delivers once through the named inbox', async () => {
    const eventBus = createBullMQAdapter({
      connection: { host: 'localhost', port: 6380 },
      prefix: `notifications-adoption-${randomUUID()}`,
    });
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        postgres: scopedUrl,
        postgresMigrations: 'apply',
        auth: 'postgres',
        sessions: 'memory',
        cache: 'memory',
      },
      eventBus,
      events: {
        reliability: {
          store: 'postgres',
          outbox: { enabled: true, pollIntervalMs: 5 },
          inbox: { enabled: true },
        },
      },
      packages: [
        createNotificationsPackage({
          dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 10 },
          reliability: {
            store: 'postgres',
            consumerName: 'notifications-production-adoption-v1',
          },
        }),
      ],
    });
    const ctx = getContext(app);
    const builderFactory = resolveCapabilityValue(ctx, NotificationsBuilderFactoryCap)!;
    const deliveryRegistry = resolveCapabilityValue(ctx, NotificationsDeliveryRegistryCap)!;
    const deliver = mock(
      async (
        _event: unknown,
        _context?: {
          readonly idempotencyKey: string;
        },
      ) => {},
    );
    deliveryRegistry.register({ deliver });

    try {
      const notification = await builderFactory({ source: 'production-adoption' }).notify({
        userId: 'user-reliable',
        type: 'adoption',
      });
      expect(notification).not.toBeNull();

      const deadline = Date.now() + 5_000;
      while (deliver.mock.calls.length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
      }

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[1]).toEqual({
        idempotencyKey: expect.any(String),
      });
      const postgres = new Pool({ connectionString: scopedUrl });
      try {
        const outbox = await postgres.query<{ status: string }>(
          'SELECT status FROM slingshot_event_outbox',
        );
        const inbox = await postgres.query<{ consumer_name: string }>(
          'SELECT consumer_name FROM slingshot_event_inbox',
        );
        expect(outbox.rows[0]?.status).toBe('delivered');
        expect(inbox.rows[0]?.consumer_name).toBe('notifications-production-adoption-v1');
      } finally {
        await postgres.end();
      }
    } finally {
      await ctx.destroy();
    }
  }, 15_000);
});
