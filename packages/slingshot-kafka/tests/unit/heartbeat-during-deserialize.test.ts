import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../helpers/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');

afterEach(() => {
  resetFakeKafkaState();
});

describe('kafkaAdapter heartbeat during deserialize', () => {
  test('calls heartbeat before and after deserialize on each consumed message', async () => {
    const heartbeatCalls: Array<{ phase: 'before' | 'after'; deserializeCalls: number }> = [];
    let deserializeCalls = 0;

    const serializer = {
      contentType: 'application/x-test-json',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, data: Uint8Array): unknown {
        deserializeCalls += 1;
        return JSON.parse(new TextDecoder().decode(data));
      },
    };

    const heartbeat = mock(async () => {
      const phase: 'before' | 'after' = deserializeCalls === 0 ? 'before' : 'after';
      heartbeatCalls.push({ phase, deserializeCalls });
    });

    const bus = createKafkaAdapter({
      brokers: ['localhost:19092'],
      serializer,
    });

    bus.on(
      'auth:login',
      () => {
        // handler is a no-op for this test
      },
      { durable: true, name: 'heartbeat-worker' },
    );
    await flushAsyncWork();

    const consumer = fakeKafkaState.consumers[0];
    expect(consumer).toBeDefined();

    await consumer?.eachMessage?.({
      topic: 'slingshot.events.auth.login',
      partition: 0,
      message: {
        offset: '0',
        key: Buffer.from('key-1'),
        headers: {},
        value: Buffer.from(serializer.serialize('auth:login', { userId: 'u-1', sessionId: 's-1' })),
      },
      heartbeat,
    });

    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(heartbeatCalls).toHaveLength(2);
    expect(heartbeatCalls[0]).toEqual({ phase: 'before', deserializeCalls: 0 });
    expect(heartbeatCalls[1]).toEqual({ phase: 'after', deserializeCalls: 1 });
    expect(deserializeCalls).toBe(1);
  });

  test('still heartbeats before deserialize when payload fails to decode', async () => {
    const errSpy = mock((..._args: unknown[]) => {});
    const originalErr = console.error;
    console.error = errSpy;

    try {
      const heartbeat = mock(async () => {});

      const serializer = {
        contentType: 'application/x-test-json',
        serialize(_event: string, payload: unknown): Uint8Array {
          return new TextEncoder().encode(JSON.stringify(payload));
        },
        deserialize(_event: string, _data: Uint8Array): unknown {
          throw new Error('boom');
        },
      };

      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        serializer,
        deserializationErrorPolicy: 'skip',
      });

      bus.on('auth:login', () => {}, { durable: true, name: 'heartbeat-fail-worker' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from('not-json'),
        },
        heartbeat,
      });

      // Heartbeat must run before deserialize attempt; failure path skips the post-deserialize beat.
      expect(heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalErr;
    }
  });
});
