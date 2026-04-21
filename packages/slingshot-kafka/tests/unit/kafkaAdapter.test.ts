import { afterEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { createEventSchemaRegistry } from '@lastshotlabs/slingshot-core';
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
});
