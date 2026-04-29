import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createNotificationSseRoute } from '../../src/sse';

type DynamicBus = {
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
};

function makeBus(): DynamicBus & { _handlers: Record<string, Set<(p: unknown) => void>> } {
  const _handlers: Record<string, Set<(p: unknown) => void>> = {};
  return {
    _handlers,
    on(event, handler) {
      if (!_handlers[event]) _handlers[event] = new Set();
      _handlers[event]!.add(handler);
    },
    off(event, handler) {
      _handlers[event]?.delete(handler);
    },
    emit(event, payload) {
      _handlers[event]?.forEach(h => h(payload));
    },
  };
}

function chunkToString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(value as Uint8Array);
}

async function drainPreamble(reader: ReadableStreamDefaultReader<unknown>): Promise<string> {
  let accumulated = '';
  while (!accumulated.includes(': connected')) {
    const { value, done } = await reader.read();
    if (done) break;
    accumulated += chunkToString(value);
  }
  return accumulated;
}

async function readUntilContains(
  reader: ReadableStreamDefaultReader<unknown>,
  needle: string,
  maxChunks = 10,
): Promise<string> {
  let accumulated = '';
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    accumulated += chunkToString(value);
    if (accumulated.includes(needle)) break;
  }
  return accumulated;
}

function makeApp(bus: DynamicBus, userId: string | null) {
  const app = new Hono();
  // Inject actor so getActorId(c) returns userId
  if (userId) {
    app.use('*', async (c, next) => {
      c.set('actor' as never, { id: userId, tenantId: null, type: 'user' } as never);
      await next();
    });
  }
  app.route('/', createNotificationSseRoute(bus as unknown as InProcessAdapter, '/sse'));
  return app;
}

describe('createNotificationSseRoute', () => {
  test('unauthenticated request returns 401', async () => {
    const bus = makeBus();
    const app = makeApp(bus, null);
    const res = await app.fetch(new Request('http://localhost/sse'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  test('authenticated request returns SSE stream with correct headers', async () => {
    const bus = makeBus();
    const app = makeApp(bus, 'user-1');
    const ac = new AbortController();
    const res = await app.fetch(new Request('http://localhost/sse', { signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    ac.abort();
    await res.body?.cancel();
  });

  test('SSE stream emits retry and connected preamble', async () => {
    const bus = makeBus();
    const app = makeApp(bus, 'user-1');
    const ac = new AbortController();
    const res = await app.fetch(new Request('http://localhost/sse', { signal: ac.signal }));
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    // Read until we have seen the full preamble (may arrive in 1 or 2 chunks)
    const preamble = await drainPreamble(reader);

    expect(preamble).toContain('retry: 5000');
    expect(preamble).toContain(': connected');

    ac.abort();
    await reader.cancel();
  });

  test('notification.created event is forwarded to matching userId only', async () => {
    const bus = makeBus();
    const app = makeApp(bus, 'user-target');
    const ac = new AbortController();
    const res = await app.fetch(new Request('http://localhost/sse', { signal: ac.signal }));
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();

    // Drain preamble (retry + connected, may be 1 or 2 chunks)
    await drainPreamble(reader);

    // Emit event for a DIFFERENT user — should not appear in this stream
    bus.emit('notifications:notification.created', {
      notification: { id: 'n-other', userId: 'user-other' },
      preferences: {},
    });

    // Emit event for THE CORRECT user
    bus.emit('notifications:notification.created', {
      notification: { id: 'n-target', userId: 'user-target' },
      preferences: {},
    });

    // Read chunks until we see the event data
    const text = await readUntilContains(reader, 'n-target');

    expect(text).toContain('notification.created');
    expect(text).toContain('n-target');
    expect(text).not.toContain('n-other');

    ac.abort();
    await reader.cancel();
  });

  test('notification.updated event is forwarded to matching userId', async () => {
    const bus = makeBus();
    const app = makeApp(bus, 'user-1');
    const ac = new AbortController();
    const res = await app.fetch(new Request('http://localhost/sse', { signal: ac.signal }));
    const reader = res.body!.getReader();

    // Drain preamble (retry + connected, may be 1 or 2 chunks)
    await drainPreamble(reader);

    bus.emit('notifications:notification.updated', { id: 'n-1', userId: 'user-1', changes: {} });

    const text = await readUntilContains(reader, 'n-1');

    expect(text).toContain('notification.updated');
    expect(text).toContain('n-1');

    ac.abort();
    await reader.cancel();
  });

  test('bus listeners are removed when stream is cancelled via abort', async () => {
    const onSpy = mock(() => {});
    const offSpy = mock(() => {});
    const stubbedBus = {
      on: onSpy,
      off: offSpy,
    } as unknown as InProcessAdapter;

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('actor' as never, { id: 'user-1', tenantId: null, type: 'user' } as never);
      await next();
    });
    app.route('/', createNotificationSseRoute(stubbedBus, '/sse'));

    const ac = new AbortController();
    const res = await app.fetch(new Request('http://localhost/sse', { signal: ac.signal }));

    // Two listeners should have been registered (created + updated)
    expect(onSpy).toHaveBeenCalledTimes(2);

    // Abort the request — triggers cleanup
    ac.abort();
    await res.body?.cancel();

    // Give the abort event handler a tick to fire
    await new Promise(r => setTimeout(r, 0));

    expect(offSpy).toHaveBeenCalledTimes(2);
    const removedEvents = (offSpy.mock.calls as unknown as [string][]).map(c => c[0]);
    expect(removedEvents).toContain('notifications:notification.created');
    expect(removedEvents).toContain('notifications:notification.updated');
  });

  test('cleanup is idempotent — double-abort does not double-remove listeners', async () => {
    const offSpy = mock(() => {});
    const stubbedBus = {
      on: mock(() => {}),
      off: offSpy,
    } as unknown as InProcessAdapter;

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('actor' as never, { id: 'user-1', tenantId: null, type: 'user' } as never);
      await next();
    });
    app.route('/', createNotificationSseRoute(stubbedBus, '/sse'));

    const ac = new AbortController();
    const res = await app.fetch(new Request('http://localhost/sse', { signal: ac.signal }));

    ac.abort();
    await res.body?.cancel();
    await new Promise(r => setTimeout(r, 0));

    // Second cancel — should not trigger additional off() calls
    await res.body?.cancel();
    await new Promise(r => setTimeout(r, 0));

    // Still exactly 2 (one per event type), not 4
    expect(offSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
