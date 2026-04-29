import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import {
  createEventDefinitionRegistry,
  createEventPublisher,
  createEventSchemaRegistry,
  createInProcessAdapter,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../../src/testing/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');
const { createKafkaConnectors } = await import('../../src/kafkaConnectors');

afterEach(async () => {
  resetFakeKafkaState();
  mock.restore();
});

describe('kafkaConnectors', () => {
  function createPublishedBus() {
    const bus = createInProcessAdapter();
    const definitions = createEventDefinitionRegistry();
    const events = createEventPublisher({ definitions, bus });

    events.register(
      defineEvent('auth:user.created', {
        ownerPlugin: 'test-auth',
        exposure: ['connector'],
        resolveScope() {
          return {};
        },
      }),
    );

    return { bus, events };
  }

  test('default duplicate publish policy warns when connector overlaps adapter topic', async () => {
    const warn = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
      });
      const connectors = createKafkaConnectors({
        brokers: ['localhost:19092'],
        outbound: [{ event: 'auth:login', topic: 'slingshot.events.auth.login' }],
      });

      await connectors.start(bus);
      await connectors.stop();

      expect(
        warn.mock.calls.some(call =>
          String(call[0]).includes('also produced by the internal Kafka event bus adapter'),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('duplicate publish policy "error" rejects overlapping outbound routes', async () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      duplicatePublishPolicy: 'error',
      outbound: [{ event: 'auth:login', topic: 'slingshot.events.auth.login' }],
    });

    await expect(connectors.start(bus)).rejects.toThrow(
      'also produced by the internal Kafka event bus adapter',
    );
  });

  test('warns when broker certificate verification is disabled', () => {
    const warn = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      createKafkaConnectors({
        brokers: ['localhost:19092'],
        ssl: { rejectUnauthorized: false },
      });

      expect(
        warn.mock.calls.some(call => String(call[0]).includes('ssl.rejectUnauthorized=false')),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('warns when outbound autoCreateTopic uses replicationFactor=1', async () => {
    const warn = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const connectors = createKafkaConnectors({
        brokers: ['localhost:19092'],
        outbound: [
          {
            event: 'auth:user.created',
            topic: 'external.users.created',
            autoCreateTopic: true,
          },
        ],
      });

      await connectors.start(createInProcessAdapter());
      await connectors.stop();

      expect(
        warn.mock.calls.some(call =>
          String(call[0]).includes('outbound autoCreateTopic with replicationFactor=1'),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('surfaces topic creation failures instead of swallowing them', async () => {
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      outbound: [
        {
          event: 'auth:user.created',
          topic: 'external.users.created',
          autoCreateTopic: true,
        },
      ],
    });

    fakeKafkaState.createTopicsErrors.push(new Error('createTopics failed'));

    await expect(connectors.start(bus)).rejects.toThrow('createTopics failed');
    expect(fakeKafkaState.adminDisconnectCalls).toBe(1);
    expect(connectors.health().started).toBe(false);
  });

  test('can be started again after a partial start failure', async () => {
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.a',
          groupId: 'group-a',
          handler: mock(async () => {}),
        },
        {
          topic: 'incoming.b',
          groupId: 'group-b',
          handler: mock(async () => {}),
        },
      ],
    });

    fakeKafkaState.consumerConnectErrors.push(new Error('connect failed once'));

    await expect(connectors.start(bus)).rejects.toThrow('connect failed once');
    expect(connectors.health().started).toBe(false);
    expect(fakeKafkaState.consumers[0]?.disconnectCalls).toBe(1);

    await expect(connectors.start(bus)).resolves.toBeUndefined();
    expect(connectors.health().started).toBe(true);
    expect(fakeKafkaState.consumers).toHaveLength(3);

    await connectors.stop();
  });

  test('outbound connectors subscribe to the bus and publish transformed payloads', async () => {
    const { bus, events } = createPublishedBus();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      outbound: [
        {
          event: 'auth:user.created',
          topic: 'external.users.created',
          schema: z.object({ userId: z.coerce.string() }),
        },
      ],
    });

    await connectors.start(bus);
    events.publish('auth:user.created', { userId: 42 } as never, { requestTenantId: null });
    await flushAsyncWork();

    expect(fakeKafkaState.producerSendCalls).toHaveLength(1);
    expect(fakeKafkaState.producerSendCalls[0]?.topic).toBe('external.users.created');
    expect(
      fakeKafkaState.producerSendCalls[0]?.messages[0]?.headers?.['slingshot.owner-plugin'],
    ).toBe('test-auth');
    expect(fakeKafkaState.producerSendCalls[0]?.messages[0]?.headers?.['slingshot.exposure']).toBe(
      'connector',
    );
    expect(
      new TextDecoder().decode(
        fakeKafkaState.producerSendCalls[0]?.messages[0]?.value as Uint8Array,
      ),
    ).toContain('"payload":{"userId":"42"}');

    await connectors.stop();
  });

  test('outbound connectors suppress raw internal bus events without connector exposure', async () => {
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      outbound: [{ event: 'auth:user.created', topic: 'external.users.created' }],
    });

    await connectors.start(bus);
    bus.emit('auth:user.created', { userId: 'raw-only' } as never);
    await flushAsyncWork();

    expect(fakeKafkaState.producerSendCalls).toHaveLength(0);

    await connectors.stop();
  });

  test('inbound connectors send exhausted failures to the DLQ', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {
      throw new Error('handler failed');
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.users',
          groupId: 'user-sync',
          maxRetries: 1,
          errorStrategy: 'dlq',
          handler,
        },
      ],
    });

    await connectors.start(bus);

    const consumer = fakeKafkaState.consumers[0];
    await consumer?.eachMessage?.({
      topic: 'incoming.users',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('user-1'),
        headers: {},
        value: Buffer.from(JSON.stringify({ id: 'user-1' })),
      },
      heartbeat: async () => {},
      pause: () => {},
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fakeKafkaState.producerSendCalls.at(-1)?.topic).toBe('incoming.users.dlq');
    expect(connectors.health().inbound[0]?.messagesDLQ).toBe(1);

    await connectors.stop();
  });

  test('inbound connectors honor concurrency and can auto-create the DLQ topic', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {
      throw new Error('handler failed');
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.billing',
          groupId: 'billing-sync',
          concurrency: 4,
          maxRetries: 1,
          errorStrategy: 'dlq',
          autoCreateDLQ: true,
          handler,
        },
      ],
    });

    await connectors.start(bus);

    expect(fakeKafkaState.consumers[0]?.runCalls[0]?.partitionsConsumedConcurrently).toBe(4);

    const consumer = fakeKafkaState.consumers[0];
    await consumer?.eachMessage?.({
      topic: 'incoming.billing',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('invoice-1'),
        headers: {},
        value: Buffer.from(JSON.stringify({ id: 'invoice-1' })),
      },
      heartbeat: async () => {},
      pause: () => {},
    });

    expect(fakeKafkaState.createTopicsCalls.at(-1)?.topics[0]?.topic).toBe('incoming.billing.dlq');
    expect(fakeKafkaState.producerSendCalls.at(-1)?.topic).toBe('incoming.billing.dlq');

    await connectors.stop();
  });

  test('inbound connectors allow maxRetries: 0 and still process the message once', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {
      throw new Error('handler failed');
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.once',
          groupId: 'once-only',
          maxRetries: 0,
          errorStrategy: 'dlq',
          handler,
        },
      ],
    });

    await connectors.start(bus);

    const consumer = fakeKafkaState.consumers[0];
    await consumer?.eachMessage?.({
      topic: 'incoming.once',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('once-1'),
        headers: {},
        value: Buffer.from(JSON.stringify({ id: 'once-1' })),
      },
      heartbeat: async () => {},
      pause: () => {},
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fakeKafkaState.producerSendCalls.at(-1)?.topic).toBe('incoming.once.dlq');

    await connectors.stop();
  });

  test('autoCreateDLQ with pause strategy is rejected at startup validation', () => {
    expect(() =>
      createKafkaConnectors({
        brokers: ['localhost:19092'],
        inbound: [
          {
            topic: 'incoming.pause',
            groupId: 'pause-only',
            errorStrategy: 'pause',
            autoCreateDLQ: true,
            handler: async () => {},
          },
        ],
      }),
    ).toThrow('autoCreateDLQ is only meaningful when errorStrategy is "dlq"');
  });

  test('inbound connector logs and continues when commitOffsets fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [{ topic: 'commit-fail.topic', groupId: 'cf-group', handler }],
    });

    try {
      await connectors.start(bus);

      // Make the next commitOffsets throw
      fakeKafkaState.commitOffsetErrors.push(new Error('broker gone'));

      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'commit-fail.topic',
        partition: 0,
        message: {
          offset: '5',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 1 })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler ran despite commit failure
      expect(handler).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to commit offset'),
        expect.anything(),
      );

      // Second message succeeds end-to-end
      await consumer?.eachMessage?.({
        topic: 'commit-fail.topic',
        partition: 0,
        message: {
          offset: '6',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 2 })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });

  test('inbound connector skips validation-rejected messages in strict mode and commits offset', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'ext.users',
          groupId: 'schema-strict-group',
          validationMode: 'strict',
          // Inline schema: userId must be non-empty
          schema: z.object({ userId: z.string().min(1) }),
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      // Message that fails schema validation (empty userId)
      await consumer?.eachMessage?.({
        topic: 'ext.users',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ userId: '' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler must NOT be called for an invalid payload
      expect(handler).not.toHaveBeenCalled();
      // Offset must still be committed (so the bad message is not reprocessed)
      expect(fakeKafkaState.consumers[0]?.commitOffsetCalls).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });

  test('outbound validation can use the shared event schema registry', async () => {
    const registry = createEventSchemaRegistry();
    registry.register(
      'auth:user.created',
      z.object({
        userId: z.string().transform(value => `user:${value}`),
      }),
    );

    const { bus, events } = createPublishedBus();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      schemaRegistry: registry,
      outbound: [{ event: 'auth:user.created', topic: 'external.users.registry' }],
    });

    await connectors.start(bus);
    events.publish('auth:user.created', { userId: 'abc' } as never, { requestTenantId: null });
    await flushAsyncWork();

    expect(
      new TextDecoder().decode(
        fakeKafkaState.producerSendCalls[0]?.messages[0]?.value as Uint8Array,
      ),
    ).toContain('"user:abc"');

    await connectors.stop();
  });

  test('inbound consumer dedupes by slingshot.message-id using the in-memory store', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [{ topic: 'incoming.dedup', groupId: 'dedup-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      const message = {
        offset: '0',
        key: null,
        headers: { 'slingshot.message-id': Buffer.from('msg-123') },
        value: Buffer.from(JSON.stringify({ id: 'event-1' })),
      };

      await consumer?.eachMessage?.({
        topic: 'incoming.dedup',
        partition: 0,
        message,
        heartbeat: async () => {},
        pause: () => {},
      });

      // Same messageId, second delivery — handler must NOT run again.
      await consumer?.eachMessage?.({
        topic: 'incoming.dedup',
        partition: 0,
        message: { ...message, offset: '1' },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);
      // Both messages still committed so dedup doesn't stall the partition.
      expect(consumer?.commitOffsetCalls).toBeGreaterThanOrEqual(2);
      expect(connectors.health().droppedMessages.inboundDeduped).toBe(1);
    } finally {
      await connectors.stop();
    }
  });

  test('inbound consumer with custom dedup store delegates to has() and set()', async () => {
    const seen = new Set<string>();
    const dedupStore = {
      has: mock(async (id: string) => seen.has(id)),
      set: mock(async (id: string, _ttlMs: number) => {
        seen.add(id);
      }),
    };
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      dedupStore,
      inbound: [{ topic: 'incoming.custom-dedup', groupId: 'cd-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];
      const message = {
        offset: '0',
        key: null,
        headers: { 'slingshot.message-id': Buffer.from('msg-x') },
        value: Buffer.from(JSON.stringify({ ok: true })),
      };

      await consumer?.eachMessage?.({
        topic: 'incoming.custom-dedup',
        partition: 0,
        message,
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(dedupStore.has).toHaveBeenCalledTimes(1);
      expect(dedupStore.set).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);

      // Replay: dedupStore.has now returns true; handler should be skipped.
      await consumer?.eachMessage?.({
        topic: 'incoming.custom-dedup',
        partition: 0,
        message: { ...message, offset: '1' },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(connectors.health().droppedMessages.inboundDeduped).toBe(1);
    } finally {
      await connectors.stop();
    }
  });

  test('outbound buffer-full overflow increments connector drop counter and fires hook', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const drops: Array<{ reason: string; topic: string }> = [];
    const { bus, events } = createPublishedBus();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      maxPendingBuffer: 2,
      outbound: [{ event: 'auth:user.created', topic: 'external.users.overflow' }],
      hooks: {
        onOutboundDrop: (event, topic, reason) => {
          drops.push({ reason, topic });
        },
      },
    });

    try {
      await connectors.start(bus);

      // Make every produce attempt fail; the first two should land in the
      // buffer (size 2), the rest should be dropped with reason buffer-full.
      for (let i = 0; i < 10; i++) {
        fakeKafkaState.producerSendErrors.push(new Error('broker down'));
      }
      for (let i = 0; i < 5; i++) {
        events.publish('auth:user.created', { userId: `u-${i}` } as never, {
          requestTenantId: null,
        });
      }
      await flushAsyncWork(10);

      const bufferDrops = drops.filter(d => d.reason === 'pending-buffer-full');
      expect(bufferDrops.length).toBeGreaterThan(0);
      const health = connectors.health();
      expect(health.droppedMessages.bufferFull).toBeGreaterThan(0);
      expect(health.droppedMessages.totalDrops).toBeGreaterThan(0);
      expect(typeof health.droppedMessages.lastDropAt).toBe('number');
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });

  test('inbound consumer flushes pending offsets when REBALANCING fires', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    let releaseHandler: (() => void) | null = null;
    const handlerStarted = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    const handler = mock(async () => {
      releaseHandler?.();
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [{ topic: 'incoming.rebal', groupId: 'rebal-group', handler }],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0]!;

      const inflight = consumer.eachMessage?.({
        topic: 'incoming.rebal',
        partition: 2,
        message: {
          offset: '41',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'rebal-1' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      await handlerStarted;
      // Trigger rebalance while the handler is still running.
      await consumer.emitEvent?.('consumer.rebalancing');
      await inflight;

      const offsets = consumer.commitOffsetCallArgs.flat();
      // After rebalance handling, offset 42 (next-after-41) must have been
      // committed at least once. The committed set may include the
      // trackedCommit call too — both are valid.
      expect(offsets.some(o => o.offset === '42' && o.partition === 2)).toBe(true);
    } finally {
      infoSpy.mockRestore();
      await connectors.stop();
    }
  });
});
