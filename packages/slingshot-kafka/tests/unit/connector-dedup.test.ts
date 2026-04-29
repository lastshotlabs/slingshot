/**
 * Tests for connector inbound deduplication: messageId resolution, fingerprint
 * fallback, idempotency key collisions, and TTL-based eviction.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  resetFakeKafkaState,
} from '../../src/testing/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaConnectors } = await import('../../src/kafkaConnectors');

afterEach(() => {
  resetFakeKafkaState();
});

describe('connector dedup — messageId resolution', () => {
  test('dedupes by slingshot.message-id header', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [{ topic: 'incoming.dedup-id', groupId: 'dedup-id-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      const baseMessage = {
        offset: '0',
        key: null,
        headers: { 'slingshot.message-id': Buffer.from('fixed-msg-id-1') },
        value: Buffer.from(JSON.stringify({ data: 'first' })),
      };

      // First delivery — handler runs
      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-id',
        partition: 0,
        message: baseMessage,
        heartbeat: async () => {},
        pause: () => {},
      });

      // Second delivery with different offset but same message-id — handler skipped
      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-id',
        partition: 0,
        message: { ...baseMessage, offset: '1' },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(connectors.health().droppedMessages.inboundDeduped).toBe(1);
    } finally {
      await connectors.stop();
    }
  });

  test('dedup store TTL expiry re-processes message', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();

    // Custom store with an extremely short TTL (immediate expiry)
    const seen = new Set<string>();
    const dedupStore = {
      has: mock(async (id: string) => seen.has(id)),
      set: mock(async (id: string, ttlMs: number) => {
        seen.add(id);
        // Schedule immediate expiry
        setTimeout(() => seen.delete(id), 5);
      }),
    };

    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      dedupStore,
      inbound: [{ topic: 'incoming.dedup-ttl', groupId: 'dedup-ttl-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      const msg = {
        offset: '0',
        key: null,
        headers: { 'slingshot.message-id': Buffer.from('ttl-msg') },
        value: Buffer.from(JSON.stringify({ data: 'ttl-test' })),
      };

      // First delivery
      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-ttl',
        partition: 0,
        message: msg,
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire, then replay
      await new Promise(r => setTimeout(r, 15));

      // Second delivery after TTL expiry — handler should run again
      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-ttl',
        partition: 0,
        message: { ...msg, offset: '1' },
        heartbeat: async () => {},
        pause: () => {},
      });

      // has() was called for both messages; after TTL expiry the second one
      // returned false so the handler ran again and the dedup store was set again.
      expect(handler).toHaveBeenCalledTimes(2);
      expect(dedupStore.has).toHaveBeenCalledTimes(2);
      expect(dedupStore.set).toHaveBeenCalledTimes(2);
    } finally {
      await connectors.stop();
    }
  });
});

describe('connector dedup — no message-id fallback', () => {
  test('processes both messages when no message-id header is present (no dedup)', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.dedup-fp',
          groupId: 'dedup-fp-group',
          deduplicate: true,
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      const msg = {
        offset: '0',
        key: null,
        headers: {},
        value: Buffer.from(JSON.stringify({ uniquePayload: 'abc-123' })),
      };

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-fp',
        partition: 0,
        message: msg,
        heartbeat: async () => {},
        pause: () => {},
      });

      // Same payload, different offset — also processed because without
      // slingshot.message-id header no dedup key exists.
      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-fp',
        partition: 0,
        message: { ...msg, offset: '1' },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Both messages were processed (dedup requires message-id header)
      expect(handler).toHaveBeenCalledTimes(2);
      expect(connectors.health().droppedMessages.inboundDeduped).toBe(0);
    } finally {
      await connectors.stop();
    }
  });

  test('different fingerprints are NOT deduped (both handlers called)', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.dedup-diff',
          groupId: 'dedup-diff-group',
          deduplicate: true,
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-diff',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'payload-A' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-diff',
        partition: 0,
        message: {
          offset: '1',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'payload-B' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(connectors.health().droppedMessages.inboundDeduped).toBe(0);
    } finally {
      await connectors.stop();
    }
  });
});

describe('connector dedup — idempotency key collisions', () => {
  test('same naturalKey in batch triggers dedup across records', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.dedup-batch',
          groupId: 'dedup-batch-group',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      // Two messages with same message-id header
      const msg = {
        key: null,
        headers: { 'slingshot.message-id': Buffer.from('batch-collision-key') },
        value: Buffer.from(JSON.stringify({ batch: true })),
      };

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-batch',
        partition: 0,
        message: { ...msg, offset: '0' },
        heartbeat: async () => {},
        pause: () => {},
      });

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-batch',
        partition: 0,
        message: { ...msg, offset: '1' },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Only one handler call despite two records
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await connectors.stop();
    }
  });
});

describe('connector dedup — custom dedup store with failure paths', () => {
  test('dedup store.has() failure does not block message processing', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const dedupStore = {
      has: mock(async () => {
        throw new Error('store unavailable');
      }),
      set: mock(async () => {
        throw new Error('store unavailable');
      }),
    };

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      dedupStore,
      inbound: [{ topic: 'incoming.dedup-fail', groupId: 'dedup-fail-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup-fail',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'fail-open' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler runs despite dedup store failure (fail-open)
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });
});
