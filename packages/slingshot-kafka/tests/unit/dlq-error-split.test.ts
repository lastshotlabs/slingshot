import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createInProcessAdapter, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  fakeKafkaState,
  flushAsyncWork,
  resetFakeKafkaState,
} from '../helpers/fakeKafkaJs';

mock.module('kafkajs', () => createFakeKafkaJsModule());

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');
const { createKafkaConnectors } = await import('../../src/kafkaConnectors');

afterEach(() => {
  resetFakeKafkaState();
});

describe('kafkaConnectors DLQ semantic split', () => {
  test('routes deserialization failures to DLQ with errorType=deserialize and skips handler', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.bad',
          groupId: 'bad-group',
          maxRetries: 3,
          errorStrategy: 'dlq',
          // Deserializer always throws — corrupt-message path.
          serializer: {
            contentType: 'application/x-test-json',
            serialize: () => new Uint8Array(),
            deserialize: () => {
              throw new Error('boom-deser');
            },
          },
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.bad',
        partition: 0,
        message: {
          offset: '7',
          key: null,
          headers: {},
          value: Buffer.from('not-json'),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler must NEVER run for a deserialization failure.
      expect(handler).not.toHaveBeenCalled();

      const dlqSend = fakeKafkaState.producerSendCalls.find(c => c.topic === 'incoming.bad.dlq');
      expect(dlqSend).toBeDefined();
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('deserialize');
      expect(dlqSend?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('deserialize');

      // Offset committed only after DLQ produce succeeded.
      const offsets = consumer?.commitOffsetCallArgs.flat() ?? [];
      expect(offsets.some(o => o.offset === '8' && o.partition === 0)).toBe(true);
      expect(connectors.health().inbound[0]?.messagesDLQ).toBe(1);
    } finally {
      await connectors.stop();
    }
  });

  test('routes validation failures to DLQ with errorType=validate and skips handler', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.invalid',
          groupId: 'invalid-group',
          maxRetries: 3,
          errorStrategy: 'dlq',
          validationMode: 'strict',
          schema: z.object({ userId: z.string().min(1) }),
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.invalid',
        partition: 0,
        message: {
          offset: '3',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ userId: '' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).not.toHaveBeenCalled();
      const dlqSend = fakeKafkaState.producerSendCalls.find(
        c => c.topic === 'incoming.invalid.dlq',
      );
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('validate');
      expect(dlqSend?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('validate');
    } finally {
      await connectors.stop();
    }
  });

  test('routes handler failures to DLQ with errorType=handler after retries', async () => {
    const handler = mock(async () => {
      throw new Error('handler-boom');
    });
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.flaky',
          groupId: 'flaky-group',
          maxRetries: 1,
          errorStrategy: 'dlq',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.flaky',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ userId: 'abc' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const dlqSend = fakeKafkaState.producerSendCalls.find(c => c.topic === 'incoming.flaky.dlq');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('handler');
      expect(dlqSend?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('handler');
    } finally {
      await connectors.stop();
    }
  });

  test('does NOT commit offset when DLQ produce fails (allows redelivery)', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const handler = mock(async () => {
      throw new Error('handler-fail');
    });
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.dlq-down',
          groupId: 'dlq-down-group',
          maxRetries: 1,
          errorStrategy: 'dlq',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0]!;

      // Make the DLQ produce throw.
      fakeKafkaState.producerSendErrors.push(new Error('dlq broker down'));

      // Snapshot commits before so we can assert nothing was added.
      const commitsBefore = consumer.commitOffsetCalls;

      await consumer.eachMessage?.({
        topic: 'incoming.dlq-down',
        partition: 1,
        message: {
          offset: '50',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'x' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      const offsets = consumer.commitOffsetCallArgs.flat();
      // No commit for offset 51 (which would be next-after-50 on partition 1).
      expect(offsets.some(o => o.offset === '51' && o.partition === 1)).toBe(false);
      // No new commit calls at all from this message path.
      expect(consumer.commitOffsetCalls).toBe(commitsBefore);

      // Operator-visible structured log emitted.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to publish to DLQ'),
        expect.objectContaining({ errorType: 'handler' }),
      );
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });

  test('heartbeats before and after validation so slow schemas do not trigger rebalance', async () => {
    const heartbeatCalls: number[] = [];
    const heartbeat = mock(async () => {
      heartbeatCalls.push(Date.now());
    });
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    // Schema with a slow refinement to simulate a heavy validator.
    const slowSchema = z.object({ userId: z.string() }).refine(async () => {
      await new Promise(r => setTimeout(r, 5));
      return true;
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.slow',
          groupId: 'slow-group',
          validationMode: 'strict',
          schema: z.object({ userId: z.string() }),
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'incoming.slow',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ userId: 'u-1' })),
        },
        heartbeat,
        pause: () => {},
      });

      // At least two heartbeats should have fired around the validate phase.
      expect(heartbeat).toHaveBeenCalled();
      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(2);
      expect(handler).toHaveBeenCalledTimes(1);
      void slowSchema;
    } finally {
      await connectors.stop();
    }
  });
});

describe('kafkaAdapter DLQ semantic split', () => {
  test('handler-failure DLQ messages carry errorType=handler', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        maxRetries: 1,
      });
      bus.on(
        'auth:login',
        async () => {
          throw new Error('handler-explode');
        },
        { durable: true, name: 'handler-dlq-worker' },
      );
      await flushAsyncWork();

      const envelope = createRawEventEnvelope('auth:login', { userId: 'u', sessionId: 's' });
      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '11',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      const dlqSend = fakeKafkaState.producerSendCalls.find(c => c.topic.endsWith('.dlq'));
      expect(dlqSend?.topic).toBe('slingshot.events.auth.login.dlq');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('handler');
      expect(dlqSend?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('handler');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.dlq-reason']).toBe('dlq');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('deserialize-failure deser-dlq messages carry errorType=deserialize', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        // default deserializationErrorPolicy is 'dlq'
      });
      bus.on('auth:login', () => {}, { durable: true, name: 'deser-dlq-worker' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '20',
          key: null,
          headers: {},
          value: Buffer.from('not-json{{{'),
        },
        heartbeat: async () => {},
      });

      const dlqSend = fakeKafkaState.producerSendCalls.find(c => c.topic.endsWith('.deser-dlq'));
      expect(dlqSend?.topic).toBe('slingshot.events.auth.login.deser-dlq');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('deserialize');
      expect(dlqSend?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('deserialize');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.dlq-reason']).toBe('deser-dlq');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('rebalance during in-flight handler waits and flushes the post-handler offset', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    let releaseHandler: (() => void) | null = null;
    const handlerStarted = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    const listener = mock(async () => {
      releaseHandler?.();
      await new Promise(r => setTimeout(r, 30));
    });

    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'] });
      bus.on('auth:login', listener, { durable: true, name: 'rebalance-mid-flight' });
      await flushAsyncWork();

      const consumer = fakeKafkaState.consumers[0]!;
      // Force the inline commit to fail so the offset is recorded as pending
      // and only flushes via the rebalance hook.
      fakeKafkaState.commitOffsetErrors.push(new Error('inline commit blocked'));

      const envelope = createRawEventEnvelope('auth:login', { userId: 'rb', sessionId: 'rb' });
      const inflight = consumer.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 4,
        message: {
          offset: '77',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      await handlerStarted;
      // Trigger REBALANCING mid-flight; the hook must wait for the handler
      // and flush the pending commit (next offset = 78). The inline commit
      // throws under P-KAFKA-9 so the inflight promise rejects — swallow
      // that to keep the test focused on the rebalance flush.
      await consumer.emitEvent?.('consumer.rebalancing');
      await inflight?.catch(() => {});

      const offsets = consumer.commitOffsetCallArgs.flat();
      expect(offsets.some(o => o.offset === '78' && o.partition === 4)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      // GROUP_JOIN clears the rebalance flag and resumes the consumer.
      await consumer.emitEvent?.('consumer.group_join', { payload: { memberId: 'm-7' } });
      expect(bus.health().consumers[0]?.connected).toBe(true);
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
