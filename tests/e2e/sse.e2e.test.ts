import { describe, expect, test } from 'bun:test';
import { defineEvent } from '@lastshotlabs/slingshot-core';
import type { EventKey, PluginSetupContext, SlingshotEventMap } from '@lastshotlabs/slingshot-core';
import { getServerContext } from '../../src/server';
import { createTestFullServer } from '../setup-e2e';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'content:document.created': Record<string, unknown>;
    'content:test.document.created': Record<string, unknown>;
    'test:sse.item.created': Record<string, unknown>;
    'test:sse.item.updated': Record<string, unknown>;
  }
}

const TEST_SSE_EVENT = 'test:sse.item.created';
const TEST_SSE_OTHER_EVENT = 'test:sse.item.updated';

function createSseDefinitionPlugin(
  keys: EventKey[] = [TEST_SSE_EVENT, TEST_SSE_OTHER_EVENT],
) {
  return {
    name: 'test-sse-definitions',
    setupMiddleware({ events }: PluginSetupContext) {
      for (const key of keys) {
        events.register(
          defineEvent(key, {
            ownerPlugin: 'test-sse-definitions',
            exposure: ['client-safe'],
            resolveScope() {
              return {};
            },
          }),
        );
      }
    },
  };
}

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

function publishRegisteredEvent(
  server: { stop(close?: boolean): void | Promise<void> },
  event: EventKey,
  payload: SlingshotEventMap[typeof event],
): void {
  const ctx = getServerContext(server as object);
  if (!ctx) {
    throw new Error('SSE test server context is unavailable');
  }
  ctx.events.publish(event, payload, { requestTenantId: null, source: 'system' });
}

describe('SSE E2E — startup validation', () => {
  test('throws when SSE path contains : (non-literal)', async () => {
    await expect(
      createTestFullServer({
        sse: {
          endpoints: {
            '/__sse/:id': { events: [TEST_SSE_EVENT] },
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
            '/__sse/*': { events: [TEST_SSE_EVENT] },
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
            '/events/feed': { events: [TEST_SSE_EVENT] },
          },
        },
      }),
    ).rejects.toThrow(/must be under the \/__sse\/ prefix/);
  });

  test('throws on WS endpoint path collision', async () => {
    await expect(
      createTestFullServer({
        plugins: [createSseDefinitionPlugin()],
        ws: {
          endpoints: { '/__sse/feed': {} },
        },
        sse: {
          endpoints: {
            '/__sse/feed': { events: [TEST_SSE_EVENT] },
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
    ).rejects.toThrow(
      /not exposed as client-safe|not registered in the event definition registry|cannot be streamed to clients/,
    );
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
    ).rejects.toThrow(/not registered in the event definition registry/);
  });
});

describe('SSE E2E — auth', () => {
  test('default handler: unauthenticated fetch → 200 (stream opens)', async () => {
    const { url, cleanup } = await createTestFullServer({
      plugins: [createSseDefinitionPlugin()],
      sse: {
        endpoints: {
          '/__sse/feed': { events: [TEST_SSE_EVENT], heartbeat: false },
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
      plugins: [createSseDefinitionPlugin()],
      sse: {
        endpoints: {
          '/__sse/secure': {
            events: [TEST_SSE_EVENT],
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
    const { url, cleanup, server } = await createTestFullServer({
      plugins: [createSseDefinitionPlugin()],
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: [TEST_SSE_EVENT],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    // Give the stream a moment to register the client
    await new Promise(r => setTimeout(r, 50));

    publishRegisteredEvent(server, TEST_SSE_EVENT, {
      id: 'thread-1',
      title: 'Hello',
    });

    const events = await readSseEvents(res, 1);
    expect(events.length).toBeGreaterThan(0);
    const eventLine = events.find(e => e.includes(TEST_SSE_EVENT));
    expect(eventLine).toBeDefined();
    expect(eventLine).toContain('thread-1');

    await res.body?.cancel();
    await cleanup();
  });

  test('emit event NOT in epConfig.events → does not appear in stream', async () => {
    const { url, cleanup, server } = await createTestFullServer({
      plugins: [createSseDefinitionPlugin()],
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: [TEST_SSE_EVENT],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    // Emit an event NOT in the list
    publishRegisteredEvent(server, TEST_SSE_OTHER_EVENT, { id: 'reply-1' });

    const events = await readSseEvents(res, 1, 300);
    const replyEvent = events.find(e => e.includes(TEST_SSE_OTHER_EVENT));
    expect(replyEvent).toBeUndefined();

    await res.body?.cancel();
    await cleanup();
  });

  test('filter suppresses event when filter returns false', async () => {
    const { url, cleanup, server } = await createTestFullServer({
      plugins: [createSseDefinitionPlugin()],
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: [TEST_SSE_EVENT],
            heartbeat: false,
            filter: () => false,
          },
        },
      },
    });

    const res = await fetch(`${url}/__sse/feed`);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));
    publishRegisteredEvent(server, TEST_SSE_EVENT, { id: 'thread-x' });

    const events = await readSseEvents(res, 1, 300);
    const eventLine = events.find(e => e.includes(TEST_SSE_EVENT));
    expect(eventLine).toBeUndefined();

    await res.body?.cancel();
    await cleanup();
  });

  test('registered custom client-safe event definitions stream successfully', async () => {
    const customEvent = 'content:test.document.created';
    const customPlugin = createSseDefinitionPlugin([customEvent]);

    const { url, cleanup, server } = await createTestFullServer({
      plugins: [customPlugin],
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
    publishRegisteredEvent(server, customEvent, {
      id: 'doc-1',
      title: 'Registered custom event',
    });

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
    const { url, cleanup, server } = await createTestFullServer({
      plugins: [createSseDefinitionPlugin()],
      sse: {
        endpoints: {
          '/__sse/feed': {
            events: [TEST_SSE_EVENT],
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
    publishRegisteredEvent(server, TEST_SSE_EVENT, {
      id: 'after-disconnect',
    });

    // No assertion on reader since it's cancelled — just verify no server error / hang
    await cleanup();
  });
});
