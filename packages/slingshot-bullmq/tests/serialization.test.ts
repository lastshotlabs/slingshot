/**
 * Serialization / deserialization tests for createBullMQAdapter.
 *
 * The adapter supports custom serializers via EventBusSerializationOptions.
 * When a custom serializer is provided, the envelope is base64-encoded and
 * stored as __slingshot_serialized. The default JSON_SERIALIZER stores the
 * raw envelope directly.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createRawEventEnvelope } from '@lastshotlabs/slingshot-core';
import { createFakeBullMQModule, fakeBullMQState } from '../src/testing/fakeBullMQ';

mock.module('bullmq', () => createFakeBullMQModule());

const { createBullMQAdapter } = await import('../src/bullmqAdapter');

afterEach(() => {
  fakeBullMQState.reset();
});

describe('createBullMQAdapter — serialization', () => {
  // -----------------------------------------------------------------------
  // Default JSON serializer
  // -----------------------------------------------------------------------

  test('default JSON serializer stores envelope directly without __slingshot_serialized', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'ser-json' });
    bus.emit('auth:login' as any, { userId: 'u1' } as any);

    const addCall = fakeBullMQState.queues[0]?.addCalls[0];
    expect(addCall).toBeDefined();
    const data = addCall.data as Record<string, unknown>;
    // Default serializer: raw envelope, no wrapper
    expect(data.__slingshot_serialized).toBeUndefined();
    expect(data.payload).toBeDefined();
    expect((data.payload as Record<string, unknown>).userId).toBe('u1');
  });

  test('default serializer envelope is a valid EventEnvelope with meta', () => {
    const bus = createBullMQAdapter({ connection: {} });
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'ser-env' });
    bus.emit('auth:login' as any, { userId: 'meta-test' } as any);

    const addCall = fakeBullMQState.queues[0]?.addCalls[0];
    const data = addCall.data as Record<string, unknown>;
    expect(data.key).toBe('auth:login');
    expect(data.meta).toBeDefined();
    expect((data.meta as Record<string, unknown>).eventId).toBeDefined();
    expect((data.meta as Record<string, unknown>).occurredAt).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Custom serializer
  // -----------------------------------------------------------------------

  test('custom serializer stores base64-encoded __slingshot_serialized', () => {
    const customSerializer = {
      contentType: 'application/x-custom',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, data: Uint8Array): unknown {
        return JSON.parse(new TextDecoder().decode(data));
      },
    };

    const bus = createBullMQAdapter({ connection: {}, serializer: customSerializer } as any);
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'custom-ser' });
    bus.emit('auth:login' as any, { userId: 'u-custom' } as any);

    const addCall = fakeBullMQState.queues[0]?.addCalls[0];
    expect(addCall).toBeDefined();
    const data = addCall.data as Record<string, unknown>;

    expect(data.__slingshot_serialized).toBeDefined();
    expect(typeof data.__slingshot_serialized).toBe('string');
    expect(data.__slingshot_content_type).toBe('application/x-custom');

    // The base64 should decode to the original envelope
    const decoded = JSON.parse(
      new TextDecoder().decode(Buffer.from(data.__slingshot_serialized as string, 'base64')),
    );
    expect(decoded.key).toBe('auth:login');
    expect(decoded.payload).toBeDefined();
    expect(decoded.payload.userId).toBe('u-custom');
  });

  test('custom deserializer restore transforms the payload in the worker', async () => {
    const serializer = {
      contentType: 'application/x-test',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, data: Uint8Array): unknown {
        const raw = JSON.parse(new TextDecoder().decode(data));
        // Apply transform: uppercase userId
        if (raw?.payload?.userId) {
          return { ...raw, payload: { ...raw.payload, userId: raw.payload.userId.toUpperCase() } };
        }
        return raw;
      },
    };

    const bus = createBullMQAdapter({ connection: {}, serializer } as any);
    const received: unknown[] = [];
    bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
      durable: true,
      name: 'deser-transform',
    });

    const queueName = fakeBullMQState.queues[0].name;
    const envelope = createRawEventEnvelope('auth:login' as any, { userId: 'u-deser' });
    // Dispatch through the fake worker — the custom deserializer runs
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', {
      __slingshot_serialized: Buffer.from(serializer.serialize('auth:login', envelope)).toString(
        'base64',
      ),
      __slingshot_content_type: 'application/x-test',
    });

    expect(received).toHaveLength(1);
    // Custom deserializer uppercased the userId
    expect((received[0] as Record<string, unknown>).userId).toBe('U-DESER');
  });

  // -----------------------------------------------------------------------
  // Malformed payloads
  // -----------------------------------------------------------------------

  test('deserializer failure throws out of the worker processor', async () => {
    const deserSpy = mock(() => {});
    const serializer = {
      contentType: 'application/json',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, _data: Uint8Array): unknown {
        deserSpy();
        throw new Error('deserialize exploded');
      },
    };

    const bus = createBullMQAdapter({ connection: {}, serializer } as any);
    const received: unknown[] = [];
    bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
      durable: true,
      name: 'malformed-test',
    });

    const queueName = fakeBullMQState.queues[0].name;
    // Dispatch with valid base64 that the custom deserializer will reject
    await expect(
      fakeBullMQState.dispatchJob(queueName, 'auth:login', {
        __slingshot_serialized: Buffer.from(
          serializer.serialize('auth:login', { key: 'auth:login', payload: {} }),
        ).toString('base64'),
        __slingshot_content_type: 'application/json',
      }),
    ).rejects.toThrow('deserialize exploded');

    expect(received).toHaveLength(0);
    expect(deserSpy).toHaveBeenCalledTimes(1);
  });

  test('non-serialized envelope data is used directly when __slingshot_serialized is absent', async () => {
    const bus = createBullMQAdapter({ connection: {} });
    const received: unknown[] = [];
    bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
      durable: true,
      name: 'raw-test',
    });

    const queueName = fakeBullMQState.queues[0].name;
    const envelope = createRawEventEnvelope('auth:login' as any, { userId: 'raw' });
    // Plain envelope without serialization wrapper — should be used directly
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', envelope);

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).userId).toBe('raw');
  });

  test('custom serializer content type is forwarded in stored job data', () => {
    const serializer = {
      contentType: 'application/vnd.myapp.v1+json',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, data: Uint8Array): unknown {
        return JSON.parse(new TextDecoder().decode(data));
      },
    };

    const bus = createBullMQAdapter({ connection: {}, serializer } as any);
    bus.on('auth:login' as any, async () => {}, { durable: true, name: 'ct-test' });
    bus.emit('auth:login' as any, { userId: 'ct' } as any);

    const addCall = fakeBullMQState.queues[0]?.addCalls[0];
    const data = addCall.data as Record<string, unknown>;
    expect(data.__slingshot_content_type).toBe('application/vnd.myapp.v1+json');
  });

  // -----------------------------------------------------------------------
  // Serializer edge cases
  // -----------------------------------------------------------------------

  test('serialize with numeric userId survives round-trip', async () => {
    const serializer = {
      contentType: 'application/json',
      serialize(_event: string, payload: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(payload));
      },
      deserialize(_event: string, data: Uint8Array): unknown {
        return JSON.parse(new TextDecoder().decode(data));
      },
    };

    const bus = createBullMQAdapter({ connection: {}, serializer } as any);
    const received: unknown[] = [];
    bus.on('auth:login' as any, async (payload: unknown) => received.push(payload), {
      durable: true,
      name: 'numeric-test',
    });

    const queueName = fakeBullMQState.queues[0].name;
    const envelope = createRawEventEnvelope('auth:login' as any, { count: 42, active: true });
    await fakeBullMQState.dispatchJob(queueName, 'auth:login', {
      __slingshot_serialized: Buffer.from(serializer.serialize('auth:login', envelope)).toString(
        'base64',
      ),
      __slingshot_content_type: 'application/json',
    });

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>).count).toBe(42);
    expect((received[0] as Record<string, unknown>).active).toBe(true);
  });
});
