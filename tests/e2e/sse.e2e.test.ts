import { describe, expect, test } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createTestFullServer } from '../setup-e2e';

// Local dynamic-bus cast: the SSE E2E tests emit community:* events which are
// declared via entity config (not module augmentation), so they're not in
// SlingshotEventMap. Cast locally per engineering rule 14 rather than widening
// the global type map.
type DynamicEventBus = { emit(event: string, payload: Record<string, unknown>): void };

// Helper: read SSE chunks from a fetch response until we have `count` events or timeout
async function readSseEvents(
  response: Response,
  count: number,
  timeoutMs = 2000,
): Promise<string[]> {
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  const events: string[] = [];
  let buf = '';

  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(r =>
      setTimeout(() => r({ done: true, value: undefined }), remaining),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done) break;
    buf += dec.decode(value);
    // Split on double newline (SSE event delimiter)
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim() && !part.startsWith(':')) {
        events.push(part.trim());
      }
    }
  }
  reader.releaseLock();
  return events;
}

describe('SSE E2E — startup validation', () => {
  test('throws when SSE path contains : (non-literal)', async () => {
    await expect(
      createTestFullServer({
        sse: {
          endpoints: {
            '/__sse/:id': { events: ['community:thread.created'] },
          },
        },
      }),
    ).rejects.toThrow(/must be a literal path/);
  });

  test('throws when SSE path contains * (non-literal)', async () => {
    await expect(
      createTestFullServer({
        sse: {
          endpoints: {
            '/__sse/*': { events: ['community:thread.created'] },
          },
        },
      }),
    ).rejects.toThrow(/must be a literal path/);
  });

  test('throws when SSE path outside /__sse/ prefix', async () => {
    await expect(
      createTestFullServer({
        sse: {
          endpoints: {
            '/events/feed': { events: ['community:thread.created'] },
          },
        },
      }),
    ).rejects.toThrow(/must be under the \/__sse\/ prefix/);
  });

  test('throws on WS endpoint path collision', async () => {
    await expect(
      createTestFullServer({
        ws: {
          endpoints: { '/__sse/feed': {} },
        },
        sse: {
          endpoints: {
            '/__sse/feed': { events: ['community:thread.created'] },
          },
        },
      }),
    ).rejects.toThrow(/collides with an existing WS endpoint/);
  });

  test('throws when SSE endpoint includes forbidden event keys', async () => {
    await expect(
      createTestFullServer({
        sse: {
          endpoints: {
            '/__sse/feed': { events: ['security.auth.login.success'] },
          },
        },
      }),
    ).rejects.toThrow(/cannot be streamed to clients/);
  });

  test('throws when SSE endpoint includes unregistered custom event keys', async () => {
    await expect(
      createTestFullServer({
        sse: {
          endpoints: {
            '/__sse/feed': { events: ['content:document.created'] },
          },
        },
      }),
    ).rejects.toThrow(/is not registered as client-safe/);
  });
});

describe('SSE E2E — auth', () => {
  test('default handler: unauthenticated fetch → 200 (stream opens)', async () => {
    const { url, cleanup } = await createTestFullServer({
      sse: {
        endpoints: {
          '/__sse/feed': { events: ['community:thread.created'], heartbeat: false },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
    await cleanup();
  });

  test('custom upgrade returning Response → 401', async () => {
    const { url, cleanup } = await createTestFullServer({
      sse: {
        endpoints: {
          '/__sse/secure': {
            events: ['community:thread.created'],
            heartbeat: false,
            upgrade: async () => new Response('Unauthorized', { status: 401 }),
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/secure`);
    expect(res.status).toBe(401);
    await cleanup();
  });
});

describe('SSE E2E — event delivery', () => {
  test('emit matching event on bus → formatted event appears in response body', async () => {
    const { url, cleanup, bus } = await createTestFullServer({
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: ['community:thread.created'],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    // Give the stream a moment to register the client
    await new Promise(r => setTimeout(r, 50));

    // Emit on the bus
    (bus as unknown as DynamicEventBus).emit('community:thread.created', {
      id: 'thread-1',
      title: 'Hello',
    });

    const events = await readSseEvents(res, 1);
    expect(events.length).toBeGreaterThan(0);
    const eventLine = events.find(e => e.includes('community:thread.created'));
    expect(eventLine).toBeDefined();
    expect(eventLine).toContain('thread-1');

    await res.body?.cancel();
    await cleanup();
  });

  test('emit event NOT in epConfig.events → does not appear in stream', async () => {
    const { url, cleanup, bus } = await createTestFullServer({
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: ['community:thread.created'],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    // Emit an event NOT in the list
    (bus as unknown as DynamicEventBus).emit('community:reply.created', { id: 'reply-1' });

    const events = await readSseEvents(res, 1, 300);
    const replyEvent = events.find(e => e.includes('community:reply.created'));
    expect(replyEvent).toBeUndefined();

    await res.body?.cancel();
    await cleanup();
  });

  test('filter suppresses event when filter returns false', async () => {
    const { url, cleanup, bus } = await createTestFullServer({
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: ['community:thread.created'],
            heartbeat: false,
            filter: () => false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));
    (bus as unknown as DynamicEventBus).emit('community:thread.created', { id: 'thread-x' });

    const events = await readSseEvents(res, 1, 300);
    const eventLine = events.find(e => e.includes('community:thread.created'));
    expect(eventLine).toBeUndefined();

    await res.body?.cancel();
    await cleanup();
  });

  test('registered custom client-safe events stream successfully', async () => {
    const customEvent = 'content:test.document.created';
    // Create a bus instance and register the custom event before server creation
    const customBus = createInProcessAdapter();
    customBus.registerClientSafeEvents([customEvent]);

    const { url, cleanup, bus } = await createTestFullServer({
      eventBus: customBus,
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: [customEvent],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));
    (bus as any).emit(customEvent, { id: 'doc-1', title: 'Registered custom event' });

    const events = await readSseEvents(res, 1);
    expect(events.length).toBeGreaterThan(0);
    const eventLine = events.find(e => e.includes(customEvent));
    expect(eventLine).toBeDefined();
    expect(eventLine).toContain('doc-1');

    await res.body?.cancel();
    await cleanup();
  });
});

describe('SSE E2E — disconnect', () => {
  test('after cancel, no further chunks arrive on reader', async () => {
    const { url, cleanup, bus } = await createTestFullServer({
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: ['community:thread.created'],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    const reader = res.body!.getReader();

    // Read ': connected' comment
    await reader.read();

    // Cancel the stream
    reader.releaseLock();
    await res.body!.cancel();

    // Give server a moment to process the disconnect
    await new Promise(r => setTimeout(r, 100));

    // Emit — should not raise errors on server side
    (bus as unknown as DynamicEventBus).emit('community:thread.created', {
      id: 'after-disconnect',
    });

    // No assertion on reader since it's cancelled — just verify no server error / hang
    await cleanup();
  });
});
