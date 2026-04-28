import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createEventSchemaRegistry, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../helpers/fakeKafkaJs';

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
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('deserialization error'),
        expect.any(Error),
      );
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

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to publish exhausted message to DLQ'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('logs a warning when commitOffsets fails and continues processing subsequent messages', async () => {
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
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '10',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      // Listener still ran despite commit failure
      expect(listener).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to commit offset'),
        expect.anything(),
      );

      // Second message succeeds end-to-end (no lingering error state)
      const consumer2 = fakeKafkaState.consumers[0];
      await consumer2?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '11',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(createRawEventEnvelope('auth:login', { userId: 'u2', sessionId: 's2' }))),
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
      await bus.shutdown();
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
      await bus.shutdown();

      expect(bus.health().pendingBufferSize).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('discarding 1 buffered message'),
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
