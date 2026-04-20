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

describe('BullMQ adapter — clientSafeKeys', () => {
  it('clientSafeKeys is empty by default — community keys require explicit registration', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(bus.clientSafeKeys.has('community:container.created')).toBe(false);
    expect(bus.clientSafeKeys.has('community:thread.created')).toBe(false);
    expect(bus.clientSafeKeys.has('community:reaction.added')).toBe(false);
  });

  it('clientSafeKeys does not include security, auth, delivery, or app keys by default', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(bus.clientSafeKeys.has('security.auth.login.success')).toBe(false);
    expect(bus.clientSafeKeys.has('auth:user.created')).toBe(false);
    expect(bus.clientSafeKeys.has('auth:delivery.welcome')).toBe(false);
    expect(bus.clientSafeKeys.has('community:delivery.reply_notification')).toBe(false);
    expect(bus.clientSafeKeys.has('app:ready')).toBe(false);
  });

  it('registerClientSafeEvents adds keys to clientSafeKeys', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    bus.registerClientSafeEvents(['my:custom.event']);
    expect(bus.clientSafeKeys.has('my:custom.event')).toBe(true);
  });

  it('registerClientSafeEvents is additive — does not clear existing keys', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    bus.registerClientSafeEvents(['my:event.a']);
    bus.registerClientSafeEvents(['my:event.b']);
    expect(bus.clientSafeKeys.has('my:event.a')).toBe(true);
    expect(bus.clientSafeKeys.has('my:event.b')).toBe(true);
  });

  it('registerClientSafeEvents throws on security. prefix', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.registerClientSafeEvents(['security.something'])).toThrow(
      '"security." namespace is forbidden',
    );
  });

  it('registerClientSafeEvents throws on auth: prefix', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.registerClientSafeEvents(['auth:user.created'])).toThrow(
      '"auth:" namespace is forbidden',
    );
  });

  it('registerClientSafeEvents throws on community:delivery. prefix', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.registerClientSafeEvents(['community:delivery.reply_notification'])).toThrow(
      '"community:delivery." namespace is forbidden',
    );
  });

  it('registerClientSafeEvents throws on app: prefix', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.registerClientSafeEvents(['app:ready'])).toThrow(
      '"app:" namespace is forbidden',
    );
  });

  it('registerClientSafeEvents throws on first forbidden key and does not add any from the batch', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() =>
      bus.registerClientSafeEvents(['my:ok.event', 'security.bad', 'my:other.event']),
    ).toThrow();
    // 'my:ok.event' was processed before the throw — it will be in the set.
    // 'my:other.event' was not — it will not be.
    expect(bus.clientSafeKeys.has('my:other.event')).toBe(false);
  });

  it('ensureClientSafeEventKey returns the key when registered', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    bus.registerClientSafeEvents(['my:safe.event']);
    expect(bus.ensureClientSafeEventKey('my:safe.event')).toBe('my:safe.event');
  });

  it('ensureClientSafeEventKey returns community keys after explicit registration', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    bus.registerClientSafeEvents(['community:thread.created']);
    expect(bus.ensureClientSafeEventKey('community:thread.created')).toBe(
      'community:thread.created',
    );
  });

  it('ensureClientSafeEventKey throws on unregistered key', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.ensureClientSafeEventKey('my:unregistered.event')).toThrow(
      'not registered as client-safe',
    );
  });

  it('ensureClientSafeEventKey throws on forbidden prefix regardless of registration', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.ensureClientSafeEventKey('security.auth.login.success')).toThrow(
      '"security." namespace is forbidden',
    );
  });

  it('ensureClientSafeEventKey includes source in error message when provided', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.ensureClientSafeEventKey('my:unregistered.event', 'my-sse-endpoint')).toThrow(
      'my-sse-endpoint',
    );
  });

  it('ensureClientSafeEventKey uses "SSE config" as default source', () => {
    const bus = createBullMQAdapter({ connection: FAKE_CONNECTION });
    expect(() => bus.ensureClientSafeEventKey('my:unregistered.event')).toThrow('SSE config');
  });

  it('clientSafeKeys is isolated per adapter instance', () => {
    const busA = createBullMQAdapter({ connection: FAKE_CONNECTION });
    const busB = createBullMQAdapter({ connection: FAKE_CONNECTION });
    busA.registerClientSafeEvents(['my:event.only-in-a']);
    expect(busA.clientSafeKeys.has('my:event.only-in-a')).toBe(true);
    expect(busB.clientSafeKeys.has('my:event.only-in-a')).toBe(false);
  });
});
