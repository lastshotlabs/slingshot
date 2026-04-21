// Unit tests for the slingshot-bullmq adapter — non-durable paths and validation.
// No Redis required. No bullmq mock required (durable constructors are never invoked).
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createBullMQAdapter as createBullMQAdapterFromIndex } from '../../packages/slingshot-bullmq/src';
import { createBullMQAdapter } from '../../packages/slingshot-bullmq/src/bullmqAdapter';
import { createEventSchemaRegistry } from '../../packages/slingshot-core/src';

// Fake connection — never actually connects in these tests (no durable subs)
const FAKE_CONNECTION = { host: 'localhost', port: 9999 };

describe('slingshot-bullmq package entrypoint', () => {
  it('re-exports createBullMQAdapter from the package index', () => {
    expect(createBullMQAdapterFromIndex).toBe(createBullMQAdapter);
  });
});

describe('BullMQ adapter — non-durable subscriptions', () => {
  it('emit() with no listeners is a no-op', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.emit('app:ready', { plugins: [] })).not.toThrow();
  });

  it('on() + emit() calls listener', async () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    const received: string[] = [];

    bus.on('auth:login', p => {
      received.push(p.userId);
    });
    bus.emit('auth:login', { userId: 'u1', sessionId: 's1' });

    await new Promise(r => setTimeout(r, 20));
    expect(received).toEqual(['u1']);
  });

  it('off() removes listener', async () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    const received: string[] = [];

    const listener = (p: { userId: string; sessionId: string }) => {
      received.push(p.userId);
    };
    bus.on('auth:logout', listener);
    bus.emit('auth:logout', { userId: 'before', sessionId: 's' });
    await new Promise(r => setTimeout(r, 20));

    bus.off('auth:logout', listener);
    bus.emit('auth:logout', { userId: 'after', sessionId: 's' });
    await new Promise(r => setTimeout(r, 20));

    expect(received).toEqual(['before']);
  });

  it('multiple non-durable listeners for the same event are all called', async () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    const calls: string[] = [];

    bus.on('app:ready', () => {
      calls.push('l1');
    });
    bus.on('app:ready', () => {
      calls.push('l2');
    });
    bus.emit('app:ready', { plugins: [] });

    await new Promise(r => setTimeout(r, 20));
    expect(calls).toContain('l1');
    expect(calls).toContain('l2');
  });

  it('shutdown() clears non-durable listeners — subsequent emit() is a no-op', async () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION }) as ReturnType<
      typeof createBullMQAdapter
    > & { shutdown(): Promise<void> };
    const received: string[] = [];

    bus.on('app:ready', () => {
      received.push('called');
    });
    await (bus as any).shutdown();

    bus.emit('app:ready', { plugins: [] });
    await new Promise(r => setTimeout(r, 20));

    expect(received).toHaveLength(0);
  });
});

describe('BullMQ adapter — validation', () => {
  it('on({ durable: true }) without name throws synchronously', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => {
      bus.on('auth:login', () => {}, { durable: true });
    }).toThrow('[BullMQAdapter] durable subscriptions require a name');
  });

  it('off() on a non-registered event is a no-op', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    const listener = () => {};
    expect(() => bus.off('auth:login', listener)).not.toThrow();
  });

  it('rejects port as a string', () => {
    expect(() =>
      createBullMQAdapter({ connection: { host: 'localhost', port: '6379' as any } }),
    ).toThrow('connection.port');
  });

  it('validates and transforms non-durable payloads before invoking listeners', async () => {
    const schemaRegistry = createEventSchemaRegistry();
    schemaRegistry.register(
      'auth:login',
      z.object({
        userId: z.string().transform(value => value.toUpperCase()),
        sessionId: z.string(),
      }),
    );
    const bus = createBullMQAdapter({
      connection: FAKE_CONNECTION,
      schemaRegistry,
      validation: 'strict',
    });
    const received: Array<{ userId: string; sessionId: string }> = [];

    bus.on('auth:login', payload => {
      received.push(payload);
    });
    bus.emit('auth:login', { userId: 'u1', sessionId: 's1' });

    await new Promise(r => setTimeout(r, 20));
    expect(received).toEqual([{ userId: 'U1', sessionId: 's1' }]);
  });

  it('throws before dispatching invalid payloads when validation is strict', () => {
    const schemaRegistry = createEventSchemaRegistry();
    schemaRegistry.register(
      'auth:login',
      z.object({
        userId: z.string(),
        sessionId: z.string(),
      }),
    );
    const bus = createBullMQAdapter({
      connection: FAKE_CONNECTION,
      schemaRegistry,
      validation: 'strict',
    });

    expect(() => bus.emit('auth:login' as string, { userId: 123, sessionId: 's1' })).toThrow(
      'validation failed',
    );
  });
});

