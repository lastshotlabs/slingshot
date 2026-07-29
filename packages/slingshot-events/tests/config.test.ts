import { describe, expect, test } from 'bun:test';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import {
  EventReliabilityTopologyError,
  eventReliabilityConfigSchema,
  validateEventReliabilityTopology,
} from '../src';

const acknowledgedBus = Object.assign(createInProcessAdapter(), {
  async publishEnvelope(envelope: { meta: { eventId: string } }) {
    return {
      eventId: envelope.meta.eventId,
      acceptedAt: new Date(0).toISOString(),
      transport: 'bullmq' as const,
      durableDestinations: 1,
    };
  },
}) as SlingshotEventBus;

describe('eventReliabilityConfigSchema', () => {
  test('applies conservative documented defaults', () => {
    const parsed = eventReliabilityConfigSchema.parse({
      store: 'postgres',
      outbox: { enabled: true },
    });

    expect(parsed.outbox).toMatchObject({
      pollIntervalMs: 250,
      batchSize: 100,
      leaseMs: 30_000,
      maxAttempts: 20,
      concurrency: 1,
    });
  });

  test('requires at least one reliability surface', () => {
    expect(() => eventReliabilityConfigSchema.parse({ store: 'postgres' })).toThrow('At least one');
  });

  test('requires a single SQLite dispatcher', () => {
    expect(() =>
      eventReliabilityConfigSchema.parse({
        store: 'sqlite',
        outbox: { enabled: true, concurrency: 2 },
      }),
    ).toThrow('concurrency');
  });
});

describe('validateEventReliabilityTopology', () => {
  test('accepts an acknowledged bus and configured SQL store', () => {
    expect(() =>
      validateEventReliabilityTopology({
        config: { store: 'postgres', outbox: { enabled: true } },
        bus: acknowledgedBus,
        postgresConfigured: true,
        sqliteConfigured: false,
      }),
    ).not.toThrow();
  });

  test('rejects an in-process bus before infrastructure access', () => {
    expect(() =>
      validateEventReliabilityTopology({
        config: { store: 'postgres', outbox: { enabled: true } },
        bus: createInProcessAdapter(),
        postgresConfigured: true,
        sqliteConfigured: false,
      }),
    ).toThrow(EventReliabilityTopologyError);
  });

  test('rejects a missing selected store', () => {
    expect(() =>
      validateEventReliabilityTopology({
        config: { store: 'sqlite', inbox: { enabled: true } },
        bus: createInProcessAdapter(),
        postgresConfigured: false,
        sqliteConfigured: false,
      }),
    ).toThrow('db.sqlite');
  });
});
