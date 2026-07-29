import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/app';

describe('event reliability bootstrap', () => {
  test('rejects an outbox with an unacknowledged bus before database access', async () => {
    await expect(
      createApp({
        db: { postgres: 'postgres://must-not-be-opened.invalid/test', mongo: false, redis: false },
        events: {
          reliability: {
            store: 'postgres',
            outbox: { enabled: true },
          },
        },
      }),
    ).rejects.toThrow('AcknowledgedEventBus');
  });

  test('rejects a selected store with no database configuration before infrastructure access', async () => {
    await expect(
      createApp({
        db: { mongo: false, redis: false },
        events: {
          reliability: {
            store: 'sqlite',
            inbox: { enabled: true },
          },
        },
      }),
    ).rejects.toThrow('db.sqlite');
  });
});
