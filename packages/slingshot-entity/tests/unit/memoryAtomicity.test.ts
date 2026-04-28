/**
 * Memory backend atomicity tests.
 *
 * The in-memory entity adapter used by tests, examples, and the dev runtime
 * must produce single-row results under contention even though
 * Bun/Node JavaScript is single-threaded. The serialization layer in
 * `operationExecutors/memoryMutex.ts` queues read-then-write work on a
 * per-store FIFO chain so any future async hop in the upsert path
 * (lazy schema, audit hooks, etc.) cannot interleave a sibling caller's
 * read with our write.
 *
 * These tests fire N concurrent operations on the same unique key and
 * assert exactly one row — the dedup contract slingshot-push relies on.
 */
import { describe, expect, test } from 'bun:test';
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { createMemoryEntityAdapter } from '../../src/configDriven/memoryAdapter';
import { op } from '../../src/configDriven/operations';

const PARALLEL_N = 100;

interface SubscriptionRecord {
  id: string;
  userId: string;
  deviceId: string;
  endpoint: string;
  lastSeenAt: Date;
}

const Subscription = defineEntity('Subscription', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string(),
    deviceId: field.string(),
    endpoint: field.string(),
    lastSeenAt: field.date({ default: 'now' }),
  },
  indexes: [index(['userId', 'deviceId'], { unique: true })],
});

describe('Memory adapter — op.upsert atomicity under contention', () => {
  test(`${PARALLEL_N} parallel upserts with the same unique key yield exactly one row`, async () => {
    const ops = {
      upsertByDevice: op.upsert({
        match: ['userId', 'deviceId'],
        set: ['endpoint', 'lastSeenAt'],
        onCreate: { id: 'uuid', lastSeenAt: 'now' },
      }),
    };

    const adapter = createMemoryEntityAdapter<
      SubscriptionRecord,
      Omit<SubscriptionRecord, 'id' | 'lastSeenAt'>,
      Partial<SubscriptionRecord>
    >(Subscription, ops);

    const upsert = adapter.upsertByDevice as (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const payload = {
      userId: 'user-1',
      deviceId: 'device-A',
      endpoint: 'https://push.example.com/abc',
    };

    const results = await Promise.all(
      Array.from({ length: PARALLEL_N }, () => upsert({ ...payload })),
    );

    // Every call must succeed.
    expect(results).toHaveLength(PARALLEL_N);

    // Every call must return the same primary key — no duplicate inserts.
    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);

    // The store itself must contain exactly one row.
    const all = await adapter.list();
    expect(all.items).toHaveLength(1);
  });

  test('parallel upserts on different unique keys all create separate rows', async () => {
    const ops = {
      upsertByDevice: op.upsert({
        match: ['userId', 'deviceId'],
        set: ['endpoint', 'lastSeenAt'],
        onCreate: { id: 'uuid', lastSeenAt: 'now' },
      }),
    };

    const adapter = createMemoryEntityAdapter<
      SubscriptionRecord,
      Omit<SubscriptionRecord, 'id' | 'lastSeenAt'>,
      Partial<SubscriptionRecord>
    >(Subscription, ops);

    const upsert = adapter.upsertByDevice as (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const distinct = 25;
    const results = await Promise.all(
      Array.from({ length: distinct }, (_, i) =>
        upsert({
          userId: 'user-1',
          deviceId: `device-${i}`,
          endpoint: `https://push.example.com/${i}`,
        }),
      ),
    );

    expect(results).toHaveLength(distinct);
    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(distinct);

    const all = await adapter.list({ limit: 200 });
    expect(all.items).toHaveLength(distinct);
  });

  test('parallel upserts return both updated and created records correctly', async () => {
    const ops = {
      upsertByDevice: op.upsert({
        match: ['userId', 'deviceId'],
        set: ['endpoint'],
        onCreate: { id: 'uuid', lastSeenAt: 'now' },
        returns: { entity: true, created: true },
      }),
    };

    const adapter = createMemoryEntityAdapter<
      SubscriptionRecord,
      Omit<SubscriptionRecord, 'id' | 'lastSeenAt'>,
      Partial<SubscriptionRecord>
    >(Subscription, ops);

    const upsert = adapter.upsertByDevice as (
      input: Record<string, unknown>,
    ) => Promise<{ entity: Record<string, unknown>; created: boolean }>;

    const payload = {
      userId: 'user-1',
      deviceId: 'device-shared',
      endpoint: 'https://push.example.com/shared',
    };

    const results = await Promise.all(
      Array.from({ length: PARALLEL_N }, () => upsert({ ...payload })),
    );

    // Exactly one created:true and (N-1) created:false.
    const createdCount = results.filter(r => r.created).length;
    const updatedCount = results.filter(r => !r.created).length;
    expect(createdCount).toBe(1);
    expect(updatedCount).toBe(PARALLEL_N - 1);

    // All rows share the same id.
    const ids = new Set(results.map(r => r.entity.id));
    expect(ids.size).toBe(1);
  });
});

describe('Memory adapter — find+insert via EntityAdapter.create with unique constraint', () => {
  test(`${PARALLEL_N} parallel creates with the same unique key yield 1 row + N-1 conflicts`, async () => {
    const adapter = createMemoryEntityAdapter<
      SubscriptionRecord,
      Omit<SubscriptionRecord, 'id' | 'lastSeenAt'>,
      Partial<SubscriptionRecord>
    >(Subscription);

    const payload = {
      userId: 'user-2',
      deviceId: 'device-create',
      endpoint: 'https://push.example.com/create',
    };

    const settled = await Promise.allSettled(
      Array.from(
        { length: PARALLEL_N },
        () =>
          adapter.create({
            ...payload,
            id: crypto.randomUUID(),
          } as unknown as Omit<SubscriptionRecord, 'lastSeenAt'>) as Promise<SubscriptionRecord>,
      ),
    );

    const fulfilled = settled.filter(s => s.status === 'fulfilled');
    const rejected = settled.filter(s => s.status === 'rejected');

    // Serialization plus the unique-constraint check must produce exactly one
    // successful insert and N-1 UNIQUE_VIOLATION rejections — never a silent
    // duplicate.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL_N - 1);

    const all = await adapter.list();
    expect(all.items).toHaveLength(1);
  });
});

describe('Memory adapter — interleaved read-then-write workload', () => {
  test('mixed upsert + fieldUpdate calls preserve invariants under contention', async () => {
    const ops = {
      upsertByDevice: op.upsert({
        match: ['userId', 'deviceId'],
        set: ['endpoint', 'lastSeenAt'],
        onCreate: { id: 'uuid', lastSeenAt: 'now' },
      }),
      touchEndpoint: op.fieldUpdate({
        match: { id: 'param:id' },
        set: ['endpoint'],
      }),
    };

    const adapter = createMemoryEntityAdapter<
      SubscriptionRecord,
      Omit<SubscriptionRecord, 'id' | 'lastSeenAt'>,
      Partial<SubscriptionRecord>
    >(Subscription, ops);

    const upsert = adapter.upsertByDevice as (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const touch = adapter.touchEndpoint as (
      params: Record<string, unknown>,
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    // Seed a single row.
    const seed = await upsert({
      userId: 'user-3',
      deviceId: 'device-mix',
      endpoint: 'initial',
    });
    const seedId = seed.id as string;

    const work: Promise<unknown>[] = [];
    for (let i = 0; i < PARALLEL_N; i += 1) {
      // Even indices upsert (no-op match), odd indices touchEndpoint.
      if (i % 2 === 0) {
        work.push(
          upsert({
            userId: 'user-3',
            deviceId: 'device-mix',
            endpoint: `upserted-${i}`,
          }),
        );
      } else {
        work.push(touch({ id: seedId }, { endpoint: `touched-${i}` }));
      }
    }

    await Promise.all(work);

    // Still exactly one row, same id.
    const all = await adapter.list();
    expect(all.items).toHaveLength(1);
    expect((all.items[0] as unknown as SubscriptionRecord).id).toBe(seedId);
  });
});
