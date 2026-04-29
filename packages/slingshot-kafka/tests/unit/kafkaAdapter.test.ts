import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createEventSchemaRegistry, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../../src/testing/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter, getKafkaAdapterIntrospectionOrNull } =
  await import('../../src/kafkaAdapter');

afterEach(async () => {
  resetFakeKafkaState();
});

describe('kafkaAdapter', () => {
  test('exposes adapter introspection and topic naming', () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      topicPrefix: 'custom.events',
    });

    const introspection = getKafkaAdapterIntrospectionOrNull(bus);
    expect(introspection).not.toBeNull();
    expect(introspection?.topicNameForEvent('auth:login')).toBe('custom.events.auth.login');
  });

  test('emit() produces durable events to Kafka topics', async () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      topicPrefix: 'custom.events',
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'audit-worker' });
    await flushAsyncWork();

    bus.emit('auth:login', { userId: 'u-1', sessionId: 's-1' });
    await flushAsyncWork();

    expect(fakeKafkaState.createTopicsCalls[0]?.topics[0]?.topic).toBe('custom.events.auth.login');
    expect(fakeKafkaState.producerSendCalls).toHaveLength(1);
    expect(fakeKafkaState.producerSendCalls[0]?.topic).toBe('custom.events.auth.login');
    expect(
      fakeKafkaState.producerSendCalls[0]?.messages[0]?.headers?.['slingshot.content-type'],
    ).toBe('application/json');
  });

  test('buffers failed durable publishes and drains them later', async () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'buffered-worker' });
    await flushAsyncWork();

    fakeKafkaState.producerSendErrors.push(new Error('temporary broker failure'));
    bus.emit('auth:login', { userId: 'u-2', sessionId: 's-2' });
    await flushAsyncWork();

    expect(bus.health().pendingBufferSize).toBe(1);
    expect(fakeKafkaState.producerSendCalls).toHaveLength(0);

    await bus._drainPendingBuffer();

    expect(bus.health().pendingBufferSize).toBe(0);
    expect(fakeKafkaState.producerSendCalls).toHaveLength(1);
  });

  test('recovers from an initial producer connection failure when draining buffered events', async () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
    });

    bus.on('auth:login', () => {}, { durable: true, name: 'reconnect-worker' });
    await flushAsyncWork();

    fakeKafkaState.producerConnectErrors.push(new Error('connect failed once'));
    bus.emit('auth:login', { userId: 'u-5', sessionId: 's-5' });
    await flushAsyncWork();

    expect(bus.health().pendingBufferSize).toBe(1);
    expect(fakeKafkaState.producerSendCalls).toHaveLength(0);

    await bus._drainPendingBuffer();

    expect(bus.health().pendingBufferSize).toBe(0);
    expect(fakeKafkaState.producerSendCalls).toHaveLength(1);
  });

  test('deserializes durable messages and applies schema validation on consume', async () => {
    const registry = createEventSchemaRegistry();
    registry.register(
      'auth:login',
      z.object({
        userId: z.string().transform(value => value.toUpperCase()),
        sessionId: z.string(),
      }),
    );

    const serializer = {
      contentType: 'application/x-test-json',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, data: Uint8Array): unknown {
        return JSON.parse(new TextDecoder().decode(data));
      },
    };

    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      serializer,
      schemaRegistry: registry,
      validation: 'strict',
    });

    const received: Array<{ userId: string; sessionId: string }> = [];
    bus.on(
      'auth:login',
      payload => {
        received.push(payload);
      },
      { durable: true, name: 'consumer-worker' },
    );
    await flushAsyncWork();

    const consumer = fakeKafkaState.consumers[0];
    await consumer?.eachMessage?.({
      topic: 'slingshot.events.auth.login',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('key-1'),
        headers: {},
        value: Buffer.from(
          serializer.serialize('auth:login', { userId: 'user-a', sessionId: 's-3' }),
        ),
      },
      heartbeat: async () => {},
    });

    expect(received).toEqual([{ userId: 'USER-A', sessionId: 's-3' }]);
  });

  test('strict validation rejects invalid payloads before publish', () => {
    const registry = createEventSchemaRegistry();
    registry.register(
      'auth:login',
      z.object({
        userId: z.string(),
        sessionId: z.string(),
      }),
    );

    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      schemaRegistry: registry,
      validation: 'strict',
    });

    expect(() => {
      bus.emit('auth:login', { userId: 'u-4' } as never);
    }).toThrow('validation failed');
    expect(fakeKafkaState.producerSendAttempts).toHaveLength(0);
  });

  test('warns when broker certificate verification is disabled', () => {
    const warn = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      createKafkaAdapter({
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

  test('warns when autoCreateTopics uses replicationFactor=1', () => {
    const warn = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      createKafkaAdapter({
        brokers: ['localhost:19092'],
        autoCreateTopics: true,
        replicationFactor: 1,
      });

      expect(
        warn.mock.calls.some(call =>
          String(call[0]).includes('autoCreateTopics=true with replicationFactor=1'),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('disconnects a durable consumer when setup fails after connect', async () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
    });

    fakeKafkaState.consumerSubscribeErrors.push(new Error('subscribe failed'));
    const originalError = console.error;
    const errorSpy = mock(() => {});
    console.error = errorSpy;

    try {
      bus.on('auth:login', () => {}, { durable: true, name: 'broken-worker' });
      await flushAsyncWork();

      expect(fakeKafkaState.consumers).toHaveLength(1);
      expect(fakeKafkaState.consumers[0]?.connectCalls).toBe(1);
      expect(fakeKafkaState.consumers[0]?.disconnectCalls).toBe(1);
      expect(bus.health().consumers).toHaveLength(0);
    } finally {
      console.error = originalError;
    }
  });

  test('logs broker addresses on adapter creation', () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      createKafkaAdapter({
        brokers: ['broker1:9092', 'broker2:9092'],
        replicationFactor: 3,
        autoCreateTopics: false,
      });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('broker1:9092'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('broker2:9092'));
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('broker connectivity will be validated on first connect'),
      );
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('supports detached on/off calls for non-durable listeners', async () => {
    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
    });

    const listener = mock(() => {});
    const { on, off } = bus;

    on('auth:login', listener);
    bus.emit('auth:login', { userId: 'u-10', sessionId: 's-10' });
    await flushAsyncWork();
    expect(listener).toHaveBeenCalledTimes(1);

    off('auth:login', listener);
    bus.emit('auth:login', { userId: 'u-11', sessionId: 's-11' });
    await flushAsyncWork();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('throws when heartbeatInterval >= sessionTimeout', () => {
    expect(() =>
      createKafkaAdapter({
        brokers: ['localhost:19092'],
        heartbeatInterval: 10_000,
        sessionTimeout: 10_000,
      }),
    ).toThrow('heartbeatInterval must be less than sessionTimeout');
  });

  test('throws when registering a duplicate durable subscription', async () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    bus.on('auth:login', () => {}, { durable: true, name: 'dup-worker' });
    await flushAsyncWork();
    expect(() => bus.on('auth:login', () => {}, { durable: true, name: 'dup-worker' })).toThrow(
      'a durable subscription named "dup-worker" for event "auth:login" already exists.',
    );
  });

  test('throws when calling off() on a durable subscription', async () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    const listener = mock(() => {});
    bus.on('auth:login', listener, { durable: true, name: 'durable-off-worker' });
    await flushAsyncWork();
    expect(() => bus.off('auth:login', listener)).toThrow(
      'cannot remove a durable subscription via off()',
    );
  });

  test('skips messages with null value and logs a warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(() => {});
    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'null-value-worker' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: { offset: '0', key: null, headers: {}, value: null },
        heartbeat: async () => {},
      });

      expect(listener).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('null message value'));
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('logs deserialization errors and skips the message without calling listener', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(() => {});
    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'deser-err-worker' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '1',
          key: null,
          headers: {},
          value: Buffer.from('not-valid-json{{{'),
        },
        heartbeat: async () => {},
      });

      expect(listener).not.toHaveBeenCalled();
      // Logger emits a single JSON line per record — check the substring
      // appears anywhere in the captured output.
      const captured = errorSpy.mock.calls.map(c => String(c[0])).join(' ');
      expect(captured).toContain('deserialization error');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('sends exhausted messages to DLQ after maxRetries failures', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(async () => {
      throw new Error('handler always fails');
    });
    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'], maxRetries: 2 });
      bus.on('auth:login', listener, { durable: true, name: 'dlq-worker' });
      await flushAsyncWork();

      const envelope = createRawEventEnvelope('auth:login', {
        userId: 'u-dlq',
        sessionId: 's-dlq',
      });
      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '2',
          key: Buffer.from('k'),
          headers: { 'slingshot.event': 'auth:login' },
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      expect(listener).toHaveBeenCalledTimes(2);
      const dlqSend = fakeKafkaState.producerSendCalls.find(c => c.topic.endsWith('.dlq'));
      expect(dlqSend?.topic).toBe('slingshot.events.auth.login.dlq');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error']).toBe('handler always fails');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('logs an error when DLQ send fails after retries are exhausted', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(async () => {
      throw new Error('listener boom');
    });
    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'], maxRetries: 1 });
      bus.on('auth:login', listener, { durable: true, name: 'dlq-fail-worker' });
      await flushAsyncWork();

      fakeKafkaState.producerSendErrors.push(new Error('DLQ broker unavailable'));

      const envelope = createRawEventEnvelope('auth:login', {
        userId: 'u-dlqfail',
        sessionId: 's-dlqfail',
      });
      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '3',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      const captured = errorSpy.mock.calls.map(c => String(c[0])).join(' ');
      expect(captured).toContain('failed to publish exhausted message to DLQ');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('re-throws and pauses partition when commitOffsets fails (P-KAFKA-9)', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(async () => {});
    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'commit-fail-worker' });
      await flushAsyncWork();

      // Make the first commitOffsets call throw
      fakeKafkaState.commitOffsetErrors.push(new Error('broker unavailable'));

      const envelope = createRawEventEnvelope('auth:login', {
        userId: 'u-commit-fail',
        sessionId: 's-commit-fail',
      });
      const consumer = fakeKafkaState.consumers[0];
      // P-KAFKA-9: commit failure now re-throws so kafkajs's consumer.run
      // surfaces the error and pauses the partition for redelivery.
      await expect(
        consumer?.eachMessage?.({
          topic: 'slingshot.events.auth.login',
          partition: 0,
          message: {
            offset: '10',
            key: null,
            headers: {},
            value: Buffer.from(JSON.stringify(envelope)),
          },
          heartbeat: async () => {},
        }),
      ).rejects.toThrow('broker unavailable');

      // Listener still ran despite the eventual commit failure.
      expect(listener).toHaveBeenCalledTimes(1);
      // Partition was paused so the broker stops redelivering until the
      // operator (or rebalance) clears the condition.
      expect(consumer?.pauseCalls?.length ?? 0).toBeGreaterThanOrEqual(1);
      const captured = errorSpy.mock.calls.map(c => String(c[0])).join(' ');
      expect(captured).toContain('failed to commit offset');

      // Second message succeeds end-to-end after the commit error clears.
      const consumer2 = fakeKafkaState.consumers[0];
      await consumer2?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '11',
          key: null,
          headers: {},
          value: Buffer.from(
            JSON.stringify(createRawEventEnvelope('auth:login', { userId: 'u2', sessionId: 's2' })),
          ),
        },
        heartbeat: async () => {},
      });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('emit() and on() after shutdown log a warning and do nothing', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const listener = mock(() => {});
    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      await bus.shutdown?.();
      const healthBefore = bus.health();
      expect(healthBefore.isShutdown).toBe(true);

      bus.emit('auth:login', { userId: 'u-post', sessionId: 's-post' });
      bus.on('auth:login', listener);
      await flushAsyncWork();

      expect(listener).not.toHaveBeenCalled();
      expect(fakeKafkaState.producerSendCalls).toHaveLength(0);
      const warnMessages = warnSpy.mock.calls.map(c => String(c[0]));
      expect(warnMessages.some(m => m.includes('emit() called after shutdown'))).toBe(true);
      expect(warnMessages.some(m => m.includes('on() called after shutdown'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('health() reflects connected consumers', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        topicPrefix: 'health.test',
        groupPrefix: 'health',
      });

      const beforeSubscribe = bus.health();
      expect(beforeSubscribe.consumers).toHaveLength(0);

      bus.on('auth:login', () => {}, { durable: true, name: 'health-worker' });
      await flushAsyncWork();
      await fakeKafkaState.consumers[0]?.emitEvent?.('consumer.group_join', {
        payload: { memberId: 'health-member' },
      });

      const after = bus.health();
      expect(after.consumers).toHaveLength(1);
      expect(after.consumers[0]?.event).toBe('auth:login');
      expect(after.consumers[0]?.connected).toBe(true);
      expect(after.consumers[0]?.groupId).toContain('health-worker');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('shutdown() logs a warning when discarding pending buffered messages', async () => {
    const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    try {
      bus.on('auth:login', () => {}, { durable: true, name: 'shutdown-buffer-worker' });
      await flushAsyncWork();

      fakeKafkaState.producerSendErrors.push(new Error('broker down'));
      bus.emit('auth:login', { userId: 'u-buf', sessionId: 's-buf' });
      await flushAsyncWork();

      expect(bus.health().pendingBufferSize).toBe(1);
      await bus.shutdown?.();

      expect(bus.health().pendingBufferSize).toBe(0);
      const warned = warnSpy.mock.calls.map(c => String(c[0])).join(' ');
      expect(warned).toContain('discarding buffered messages');
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('flushes uncommitted offsets when the consumer rebalances', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    let inHandler = false;
    let releaseHandler: (() => void) | null = null;
    const handlerStarted = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    const listener = mock(async () => {
      inHandler = true;
      releaseHandler?.();
      await new Promise(resolve => setTimeout(resolve, 30));
      inHandler = false;
    });

    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'rebalance-worker' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0]!;
      // First commit attempt fails so the offset stays recorded as pending;
      // the rebalance hook must flush it on the next commitOffsets call.
      fakeKafkaState.commitOffsetErrors.push(new Error('first commit blocked'));

      const envelope = createRawEventEnvelope('auth:login', {
        userId: 'u-rebal',
        sessionId: 's-rebal',
      });
      const handlerPromise = consumer.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '99',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      // Wait until the handler has actually started before triggering rebalance
      // so we can assert the rebalance hook quiesces in-flight work.
      await handlerStarted;
      expect(inHandler).toBe(true);
      await consumer.emitEvent?.('consumer.rebalancing');
      // After rebalance the handler should have completed and we should have
      // observed at least one commitOffsets call carrying offset 100. The
      // first commit attempt throws (P-KAFKA-9 surfaces it), so handlerPromise
      // rejects — swallow that since the test asserts on side effects.
      await handlerPromise?.catch(() => {});

      const flushed = consumer.commitOffsetCallArgs.flat().some(call => call.offset === '100');
      expect(flushed).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // GROUP_JOIN clears the rebalance flag.
      await consumer.emitEvent?.('consumer.group_join', { payload: { memberId: 'm-1' } });
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('health() exposes drop counters and the last drop reason', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const drops: Array<{ reason: string; event: string }> = [];
    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        onDrop: event => {
          drops.push({ reason: event.reason, event: event.event });
        },
      });
      bus.on('auth:login', () => {}, { durable: true, name: 'drop-stat-worker' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0]!;
      // Two null-value messages each record a drop with reason 'null-message-value'.
      await consumer.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: { offset: '0', key: null, headers: {}, value: null },
        heartbeat: async () => {},
      });
      await consumer.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: { offset: '1', key: null, headers: {}, value: null },
        heartbeat: async () => {},
      });

      const health = bus.health();
      expect(health.droppedMessages.totalDrops).toBe(2);
      expect(health.droppedMessages.byReason['null-message-value']).toBe(2);
      expect(health.droppedMessages.lastDropReason).toBe('null-message-value');
      expect(typeof health.droppedMessages.lastDropAt).toBe('number');
      expect(drops).toHaveLength(2);
      expect(drops[0]?.reason).toBe('null-message-value');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('onDrop fires when the pending buffer overflows', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const drops: Array<{ reason: string }> = [];
    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        onDrop: event => {
          drops.push({ reason: event.reason });
        },
      });
      bus.on('auth:login', () => {}, { durable: true, name: 'overflow-worker' });
      await flushAsyncWork();

      // Force every send to fail. The first 1000 fill the pending buffer; the
      // rest hit the buffer-full path and call notifyDrop.
      for (let i = 0; i < 1010; i++) {
        fakeKafkaState.producerSendErrors.push(new Error('broker down'));
      }
      for (let i = 0; i < 1010; i++) {
        bus.emit('auth:login', { userId: `u-${i}`, sessionId: `s-${i}` });
      }
      await flushAsyncWork(20);

      const bufferFull = drops.filter(d => d.reason === 'pending-buffer-full');
      expect(bufferFull.length).toBeGreaterThan(0);
      expect(bus.health().droppedMessages.byReason['pending-buffer-full']).toBeGreaterThan(0);
      expect(bus.health().droppedMessages.lastDropReason).toBe('pending-buffer-full');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
