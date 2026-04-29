/**
 * Tests for connector inbound/outbound transforms, schema validation, and
 * payload mutation.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import {
  createEventDefinitionRegistry,
  createEventPublisher,
  createInProcessAdapter,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import {
  createFakeKafkaJsModule,
  createTestState,
  flushAsyncWork,
} from '../../src/testing/fakeKafkaJs';

const { state, reset } = createTestState();

mock.module('kafkajs', () => createFakeKafkaJsModule(state));

const { createKafkaConnectors } = await import('../../src/kafkaConnectors');

afterEach(() => {
  reset();
});

/**
 * Poll until a condition is met or the timeout expires.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('connector inbound transforms', () => {
  test('inbound transform modifies payload before handler receives it', async () => {
    const bus = createInProcessAdapter();
    const received: unknown[] = [];
    const handler = mock(async (payload: unknown) => {
      received.push(payload);
    });

    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.transform',
          groupId: 'transform-group',
          transform: (payload: unknown) => {
            const p = payload as Record<string, unknown>;
            return { ...p, transformed: true, upperName: String(p.name ?? '').toUpperCase() };
          },
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.transform',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ name: 'Alice', value: 42 })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(received[0]).toEqual({
        name: 'Alice',
        value: 42,
        transformed: true,
        upperName: 'ALICE',
      });
    } finally {
      await connectors.stop();
    }
  });

  test('inbound transform returning null skips handler and commits offset', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {});

    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.skip',
          groupId: 'skip-group',
          transform: () => null, // signal to skip
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.skip',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'skip-me' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler must NOT be called when transform returns null
      expect(handler).not.toHaveBeenCalled();
      // Offset must be committed to not reprocess
      expect(state.consumers[0]?.commitOffsetCalls).toBeGreaterThan(0);
    } finally {
      await connectors.stop();
    }
  });

  test('inbound transform throw routes to error strategy', async () => {
    const bus = createInProcessAdapter();
    const handler = mock(async () => {});

    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      inbound: [
        {
          topic: 'incoming.transform-err',
          groupId: 'transform-err-group',
          maxRetries: 1,
          errorStrategy: 'dlq',
          transform: () => {
            throw new Error('transform-crash');
          },
          handler,
        },
      ],
    });

    try {
      await connectors.start(bus);
      const consumer = state.consumers[0];

      await consumer?.eachMessage?.({
        topic: 'incoming.transform-err',
        partition: 0,
        message: {
          offset: '0',
          key: null,
          headers: {},
          value: Buffer.from(JSON.stringify({ id: 'x' })),
        },
        heartbeat: async () => {},
        pause: () => {},
      });

      // Handler must NOT run — transform threw before reaching handler
      expect(handler).not.toHaveBeenCalled();
      // DLQ should contain the message
      const dlqSend = state.producerSendCalls.find(c => c.topic === 'incoming.transform-err.dlq');
      expect(dlqSend).toBeDefined();
      expect(dlqSend?.messages[0]?.headers?.['slingshot.error-type']).toBe('validate');
    } finally {
      await connectors.stop();
    }
  });
});

describe('connector outbound transforms', () => {
  test('outbound transform mutates payload before Kafka publish', async () => {
    const bus = createInProcessAdapter();
    const definitions = createEventDefinitionRegistry();
    definitions.register(
      defineEvent('auth:user.created', {
        ownerPlugin: 'test',
        exposure: ['connector'],
        resolveScope() {
          return {};
        },
      }),
    );
    const events = createEventPublisher({ definitions, bus });

    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      outbound: [
        {
          event: 'auth:user.created',
          topic: 'external.users.transformed',
          transform: envelope => {
            return {
              ...(envelope.payload as Record<string, unknown>),
              masked: true,
              email: 'redacted@example.com',
            };
          },
        },
      ],
    });

    try {
      await connectors.start(bus);
      await flushAsyncWork();
      events.publish('auth:user.created', { userId: 'u-1', email: 'user@example.com' } as never, {
        requestTenantId: null,
      });
      await waitFor(() => state.producerSendCalls.length >= 1);

      expect(state.producerSendCalls).toHaveLength(1);
      const sentPayload = JSON.parse(
        new TextDecoder().decode(state.producerSendCalls[0]?.messages[0]?.value as Uint8Array),
      );
      expect(sentPayload.payload).toEqual({
        userId: 'u-1',
        email: 'redacted@example.com',
        masked: true,
      });
    } finally {
      await connectors.stop();
    }
  });

  test('outbound transform returning null suppresses the publish', async () => {
    const bus = createInProcessAdapter();
    const definitions = createEventDefinitionRegistry();
    definitions.register(
      defineEvent('auth:user.created', {
        ownerPlugin: 'test',
        exposure: ['connector'],
        resolveScope() {
          return {};
        },
      }),
    );
    const events = createEventPublisher({ definitions, bus });

    const suppressed: Array<{ event: string; topic: string }> = [];
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      outbound: [
        {
          event: 'auth:user.created',
          topic: 'external.users.suppressed',
          transform: () => null,
        },
      ],
      hooks: {
        onOutboundSuppressed: (event, topic, _reason) => {
          suppressed.push({ event, topic });
        },
      },
    });

    try {
      await connectors.start(bus);
      await flushAsyncWork();
      events.publish('auth:user.created', { userId: 'u-1' } as never, {
        requestTenantId: null,
      });
      await waitFor(() => suppressed.length > 0);

      // No produce should happen
      expect(state.producerSendCalls).toHaveLength(0);
      // Suppression hook fired
      expect(suppressed.length).toBeGreaterThan(0);
    } finally {
      await connectors.stop();
    }
  });

  test('outbound schema validation rejects invalid payloads', async () => {
    const bus = createInProcessAdapter();
    const definitions = createEventDefinitionRegistry();
    definitions.register(
      defineEvent('auth:user.created', {
        ownerPlugin: 'test',
        exposure: ['connector'],
        resolveScope() {
          return {};
        },
      }),
    );
    const events = createEventPublisher({ definitions, bus });

    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      validationMode: 'strict',
      outbound: [
        {
          event: 'auth:user.created',
          topic: 'external.users.validated',
          schema: z.object({ userId: z.string().min(1), email: z.string().email() }),
        },
      ],
    });

    try {
      await connectors.start(bus);
      await flushAsyncWork();

      // Publish with missing email — should be blocked by schema
      events.publish('auth:user.created', { userId: 'u-1' } as never, { requestTenantId: null });
      // Validation is synchronous (throws before produce), so a brief settle is enough.
      await waitFor(() => true);

      // No produce should happen — validation failed
      expect(state.producerSendCalls).toHaveLength(0);
    } finally {
      await connectors.stop();
    }
  });

  test('outbound validation in warn mode logs but still publishes', async () => {
    const bus = createInProcessAdapter();
    const definitions = createEventDefinitionRegistry();
    definitions.register(
      defineEvent('auth:user.created', {
        ownerPlugin: 'test',
        exposure: ['connector'],
        resolveScope() {
          return {};
        },
      }),
    );
    const events = createEventPublisher({ definitions, bus });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const connectors = createKafkaConnectors({
      brokers: ['localhost:19092'],
      validationMode: 'warn',
      outbound: [
        {
          event: 'auth:user.created',
          topic: 'external.users.warn-validated',
          schema: z.object({ userId: z.string().min(1), email: z.string().email() }),
        },
      ],
    });

    try {
      await connectors.start(bus);
      await flushAsyncWork();
      events.publish('auth:user.created', { userId: 'u-1' } as never, { requestTenantId: null });
      await waitFor(() => state.producerSendCalls.length >= 1);

      // In warn mode, the message should still be published
      expect(state.producerSendCalls).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await connectors.stop();
    }
  });
});
