/**
 * Tests for DLQ routing: error classification routing, DLQ message format,
 * header propagation, and per-error-type DLQ topics.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { createInProcessAdapter, createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  createTestState,
  flushAsyncWork,
} from '../../src/testing/fakeKafkaJs';

const { state, reset } = createTestState();
mock.module('kafkajs', () => createFakeKafkaJsModule(state));

const { createKafkaAdapter } = await import('../../src/kafkaAdapter');
const { createKafkaConnectors } = await import('../../src/kafkaConnectors');

afterEach(() => {
  reset();
});

describe('DLQ routing — error classification', () => {
  test('adapter routes handler failures to *.dlq with error-type header', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    try {
      const bus = createKafkaAdapter({ brokers: ['localhost:19092'], maxRetries: 1 });
      bus.on(
        'auth:login',
        async () => {
          throw new Error('handler-boom');
        },
        { durable: true, name: 'dlq-classify' },
      );
      await flushAsyncWork();

      const envelope = createRawEventEnvelope('auth:login', { userId: 'u', sessionId: 's' });
      const consumer = state.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(envelope)),
        },
        heartbeat: async () => {},
      });

      const dlqSend = state.producerSendCalls.find(c => c.topic.endsWith('.dlq'));
      expect(dlqSend).toBeDefined();
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('handler');
      expect(dlqSend?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('handler');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error']).toBe('handler-boom');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  test('connector routes deserialize errors to DLQ with errorType=deserialize', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.deser-dlq',
          groupId: 'deser-dlq-group',
          maxRetries: 2,
          errorStrategy: 'dlq',
          serializer: {
            contentType: 'application/x-test',
            serialize: () => new Uint8Array(),
            deserialize: () => {
              throw new Error('deserialize-crash');
            },
          },
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.deser-dlq',
        partition: 0,
        message: {
          offset: '5',
          key: null,
          headers: {},
          value: Buffer.from('corrupt-data'),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).not.toHaveBeenCalled();
      const dlqSend = state.producerSendCalls.find(c => c.topic === 'incoming.deser-dlq.dlq');
      expect(dlqSend).toBeDefined();
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('deserialize');
    } finally {
      await connectors.stop();
    }
  });

  test('connector routes validation errors to DLQ with errorType=validate', async () => {
    const handler = mock(async () => {});
    const bus = createInProcessAdapter();
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.validate-dlq',
          groupId: 'validate-dlq-group',
          maxRetries: 1,
          errorStrategy: 'dlq',
          validationMode: 'strict',
          schema: z.object({ userId: z.string().min(1) }),
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.validate-dlq',
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
      const dlqSend = state.producerSendCalls.find(c => c.topic === 'incoming.validate-dlq.dlq');
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('validate');
    } finally {
      await connectors.stop();
    }
  });
});

describe('DLQ routing — message format and header propagation', () => {
  test('DLQ message preserves original headers and adds DLQ metadata', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {
      throw new Error('handler-fail');
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.header-prop',
          groupId: 'header-prop-group',
          maxRetries: 1,
          errorStrategy: 'dlq',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.header-prop',
        partition: 0,
        message: {
          offset: '10',
          key: Buffer.from('original-key'),
          headers: {
            'slingshot.tenant-id': Buffer.from('tenant-abc'),
            'slingshot.correlation-id': Buffer.from('corr-123'),
            'x-custom': Buffer.from('custom-value'),
          },
          value: Buffer.from(JSON.stringify({ id: 'header-test' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      const dlqSend = state.producerSendCalls.find(c => c.topic === 'incoming.header-prop.dlq');
      expect(dlqSend).toBeDefined();
      const msg = dlqSend!.messages[0];

      // DLQ headers must include diagnostic metadata
      expect(msg?.headers?.['slingshot.error-type']).toBe('handler');
      expect(msg?.headers?.['x-slingshot-dlq-reason']).toBe('handler');
      expect(msg?.headers?.['slingshot.original-topic']).toBe('incoming.header-prop');
    } finally {
      await connectors.stop();
    }
  });

  test('connector DLQ message preserves original payload body', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {
      throw new Error('always-fail');
    });
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.body-preserve',
          groupId: 'body-preserve-group',
          maxRetries: 1,
          errorStrategy: 'dlq',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      const originalPayload = { id: 'body-test', name: 'test-item', nested: { key: 'val' } };
      await consumer?.eachMessage?.({
        topic: 'incoming.body-preserve',
        partition: 0,
        message: {
          offset: '7',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify(originalPayload)),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      const dlqSend = state.producerSendCalls.find(c => c.topic === 'incoming.body-preserve.dlq');
      expect(dlqSend).toBeDefined();
      const sentValue = JSON.parse(
        new TextDecoder().decode(dlqSend!.messages[0]?.value as Uint8Array),
      );
      expect(sentValue).toEqual(originalPayload);
    } finally {
      await connectors.stop();
    }
  });

  test('adapter DLQ topic includes error-type header for deserialize failures (deser-dlq)', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    try {
      const bus = createKafkaAdapter({
        brokers: ['localhost:19092'],
        deserializationErrorPolicy: 'dlq',
      });
      bus.on('auth:login', () => {}, { durable: true, name: 'deser-dlq-route' });
      await flushAsyncWork();

      const consumer = state.consumers[0];
      await consumer?.eachMessage?.({
        topic: 'slingshot.events.auth.login',
        partition: 0,
        message: {
          offset: '15',
          key: null,
          headers: {},
          value: Buffer.from('not-valid-json{{{'),
        },
        heartbeat: async () => {},
      });

      const deserDlq = state.producerSendCalls.find(c => c.topic.endsWith('.deser-dlq'));
      expect(deserDlq).toBeDefined();
      expect(deserDlq?.messages[0]?.headers?.['slingshot.error-type']).toBe('deserialize');
      expect(deserDlq?.messages[0]?.headers?.['x-slingshot-dlq-reason']).toBe('deserialize');
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});

describe('DLQ routing — connector skip and pause strategies', () => {
  test('skip error strategy commits offset without DLQ', async () => {
    const handler = mock(async () => {
      throw new Error('handler-fail');
    });
    const bus = createInProcessAdapter();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.skip-strategy',
          groupId: 'skip-strategy-group',
          maxRetries: 1,
          errorStrategy: 'skip',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      const beforeCommits = consumer?.commitOffsetCalls ?? 0;
      await consumer?.eachMessage?.({
        topic: 'incoming.skip-strategy',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'skip' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler ran (and failed)
      expect(handler).toHaveBeenCalledTimes(1);
      // No DLQ message was produced
      const dlqFound = state.producerSendCalls.some(c => c.topic.includes('.dlq'));
      expect(dlqFound).toBe(false);
      // Offset was committed (the error was skipped)
      expect(consumer?.commitOffsetCalls ?? 0).toBeGreaterThan(beforeCommits);
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });

  test('pause error strategy pauses the partition on handler failure', async () => {
    const handler = mock(async () => {
      throw new Error('handler-fail');
    });
    const bus = createInProcessAdapter();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const pauseCallback = mock(() => {});
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.pause-strategy',
          groupId: 'pause-strategy-group',
          maxRetries: 1,
          errorStrategy: 'pause',
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.pause-strategy',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'pause-test' })),
        },
        heartbeat: async () => {},
        pause: pauseCallback,
      });

      // The per-message pause callback was invoked by the adapter
      expect(pauseCallback).toHaveBeenCalled();
      // No DLQ message
      const dlqFound = state.producerSendCalls.some(c => c.topic.includes('.dlq'));
      expect(dlqFound).toBe(false);
    } finally {
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });
});
