import { describe, expect, test } from 'bun:test';
import type {
  AcknowledgedEventBus,
  EventEnvelope,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  type LeasedOutboxRow,
  type OutboxDispatchRepository,
  createOutboxDispatcher,
} from '../src';

function busWith(
  publish: (envelope: EventEnvelope) => Promise<{
    eventId: string;
    acceptedAt: string;
    transport: 'bullmq';
    durableDestinations: number;
  }>,
): AcknowledgedEventBus {
  return Object.assign(createInProcessAdapter(), {
    publishEnvelope: publish,
  }) as SlingshotEventBus & AcknowledgedEventBus;
}

function fixture(envelopeJson?: string) {
  const envelope = createRawEventEnvelope('app:shutdown', { signal: 'SIGTERM' });
  const row: LeasedOutboxRow = {
    id: crypto.randomUUID(),
    eventId: envelope.meta.eventId,
    eventKey: envelope.key,
    envelopeJson: envelopeJson ?? JSON.stringify(envelope),
    attempts: 0,
  };
  const calls = {
    delivered: 0,
    released: [] as Array<{ attempts: number; dead: boolean; errorMessage: string }>,
    releasedOwner: 0,
  };
  const repository: OutboxDispatchRepository = {
    async claim() {
      return [row];
    },
    async markDelivered() {
      calls.delivered++;
      return true;
    },
    async release(input) {
      calls.released.push(input);
      return true;
    },
    async releaseOwner() {
      calls.releasedOwner++;
      return 0;
    },
  };
  return { envelope, repository, calls };
}

describe('createOutboxDispatcher', () => {
  test('marks a row delivered only after matching durable acknowledgement', async () => {
    const { envelope, repository, calls } = fixture();
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(async received => ({
        eventId: received.meta.eventId,
        acceptedAt: new Date(0).toISOString(),
        transport: 'bullmq',
        durableDestinations: 1,
      })),
      config: { enabled: true },
    });

    expect(await dispatcher.dispatchOnce()).toBe(1);
    expect(calls.delivered).toBe(1);
    expect(calls.released).toHaveLength(0);
    expect(envelope.meta.eventId).toBeTruthy();
  });

  test('keeps a zero-destination acknowledgement retryable', async () => {
    const { repository, calls } = fixture();
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(async envelope => ({
        eventId: envelope.meta.eventId,
        acceptedAt: new Date(0).toISOString(),
        transport: 'bullmq',
        durableDestinations: 0,
      })),
      config: { enabled: true, maxAttempts: 2, retry: { initialMs: 1, maxMs: 1, jitter: 0 } },
    });

    await dispatcher.dispatchOnce();
    expect(calls.delivered).toBe(0);
    expect(calls.released).toEqual([expect.objectContaining({ attempts: 1, dead: false })]);
  });

  test('dead-letters malformed persisted envelopes without publishing', async () => {
    const { repository, calls } = fixture('{not-json');
    let publications = 0;
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(async envelope => {
        publications++;
        return {
          eventId: envelope.meta.eventId,
          acceptedAt: new Date(0).toISOString(),
          transport: 'bullmq',
          durableDestinations: 1,
        };
      }),
      config: { enabled: true, maxAttempts: 1 },
    });

    await dispatcher.dispatchOnce();
    expect(publications).toBe(0);
    expect(calls.released[0]).toMatchObject({ attempts: 1, dead: true });
  });

  test('releases dispatcher-owned leases during shutdown', async () => {
    const { repository, calls } = fixture();
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(async envelope => ({
        eventId: envelope.meta.eventId,
        acceptedAt: new Date(0).toISOString(),
        transport: 'bullmq',
        durableDestinations: 1,
      })),
      config: { enabled: true },
    });

    await dispatcher.shutdown();
    expect(calls.releasedOwner).toBe(1);
    expect(await dispatcher.dispatchOnce()).toBe(0);
  });

  test('retries a broker outage with the byte-identical envelope and event ID', async () => {
    const { envelope, repository, calls } = fixture();
    const received: string[] = [];
    let available = false;
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(async published => {
        received.push(JSON.stringify(published));
        if (!available) throw new Error('broker unavailable');
        return {
          eventId: published.meta.eventId,
          acceptedAt: new Date(0).toISOString(),
          transport: 'bullmq',
          durableDestinations: 1,
        };
      }),
      config: { enabled: true, retry: { initialMs: 1, maxMs: 1, jitter: 0 } },
    });

    await dispatcher.dispatchOnce();
    available = true;
    await dispatcher.dispatchOnce();

    expect(received).toEqual([JSON.stringify(envelope), JSON.stringify(envelope)]);
    expect(calls.released).toHaveLength(1);
    expect(calls.delivered).toBe(1);
  });

  test('re-publishes the same event after acceptance before finalize is lost', async () => {
    const { envelope, repository } = fixture();
    let finalizations = 0;
    repository.markDelivered = async () => {
      finalizations++;
      return finalizations > 1;
    };
    const publishedIds: string[] = [];
    const bus = busWith(async published => {
      publishedIds.push(published.meta.eventId);
      return {
        eventId: published.meta.eventId,
        acceptedAt: new Date(0).toISOString(),
        transport: 'bullmq',
        durableDestinations: 1,
      };
    });

    await createOutboxDispatcher({
      repository,
      bus,
      owner: 'crashed-after-accept',
      config: { enabled: true },
    }).dispatchOnce();
    await createOutboxDispatcher({
      repository,
      bus,
      owner: 'lease-recovery',
      config: { enabled: true },
    }).dispatchOnce();

    expect(publishedIds).toEqual([envelope.meta.eventId, envelope.meta.eventId]);
    expect(finalizations).toBe(2);
  });

  test('shutdown bounds an in-flight publication and releases its lease', async () => {
    const { repository, calls } = fixture();
    let resolvePublish:
      | ((value: {
          eventId: string;
          acceptedAt: string;
          transport: 'bullmq';
          durableDestinations: number;
        }) => void)
      | undefined;
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(
        envelope =>
          new Promise(resolve => {
            resolvePublish = value => resolve(value);
            void envelope;
          }),
      ),
      config: { enabled: true, shutdownGraceMs: 1 },
    });

    const dispatch = dispatcher.dispatchOnce();
    await Promise.resolve();
    await dispatcher.shutdown();
    expect(calls.releasedOwner).toBe(1);
    resolvePublish?.({
      eventId: crypto.randomUUID(),
      acceptedAt: new Date(0).toISOString(),
      transport: 'bullmq',
      durableDestinations: 1,
    });
    await dispatch;
  });

  test('redacts credentials and tokens from persisted publication errors', async () => {
    const { repository, calls } = fixture();
    const dispatcher = createOutboxDispatcher({
      repository,
      bus: busWith(async () => {
        throw new Error(
          'connect postgres://admin:hunter2@db.example/app Bearer abc.def token=top-secret',
        );
      }),
      config: { enabled: true },
      random: () => 0.5,
    });

    await dispatcher.dispatchOnce();

    const message = calls.released[0]?.errorMessage ?? '';
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('abc.def');
    expect(message).not.toContain('top-secret');
  });
});
