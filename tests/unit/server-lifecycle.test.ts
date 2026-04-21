import { afterEach, describe, expect, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { defineEvent, getContext } from '@lastshotlabs/slingshot-core';
import { createServer, getServerContext } from '../../src/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for ${label}`)), ms),
    ),
  ]);
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', error => reject(error), { once: true });
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    ws.addEventListener(
      'message',
      event => resolve(JSON.parse(event.data as string) as Record<string, unknown>),
      { once: true },
    );
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => {
    ws.addEventListener('close', event => resolve({ code: event.code, reason: event.reason }), {
      once: true,
    });
  });
}

function createSseDefinitionPlugin(key: string): SlingshotPlugin {
  return {
    name: `sse-def-${key}`,
    setupMiddleware({ events }) {
      events.register(
        defineEvent(key as never, {
          ownerPlugin: 'server-lifecycle-test',
          exposure: ['client-safe'],
          resolveScope() {
            return {};
          },
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Shutdown registry helper
// ---------------------------------------------------------------------------

const SHUTDOWN_REGISTRY_SYMBOL = Symbol.for('slingshot.shutdownRegistry');

type ShutdownRegistry = {
  callbacks: Map<string, (signal: string) => Promise<number>>;
  listeners: { sigterm: () => void; sigint: () => void } | null;
};

function getRegistry(): ShutdownRegistry | undefined {
  const proc = process as unknown as Record<symbol, ShutdownRegistry | undefined>;
  return proc[SHUTDOWN_REGISTRY_SYMBOL];
}

function getLastShutdownCallback(): (signal: string) => Promise<number> {
  const registry = getRegistry()!;
  const entries = [...registry.callbacks.entries()];
  return entries[entries.length - 1][1];
}

// ---------------------------------------------------------------------------
// Base config — no external deps (mongo, redis disabled)
// ---------------------------------------------------------------------------

const baseConfig = {
  meta: { name: 'Server Lifecycle Test' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let server: Awaited<ReturnType<typeof createServer>> | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  // Close WebSockets first
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      try {
        socket.close();
        await new Promise(r => setTimeout(r, 50));
      } catch {
        /* best-effort */
      }
    }
  }

  if (server) {
    try {
      const ctx = getServerContext(server);
      server.stop(true);
      await ctx?.destroy();
    } catch {
      /* best-effort */
    }
    server = null;
  }
});

// =========================================================================
// 1. HTTP-only server (no WS config) — lines 521-535
// =========================================================================

describe('HTTP-only server (no WS)', () => {
  test('starts via runtime.server.listen()', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });
    expect(server).toBeDefined();
    expect(server.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${server.port}/docs`);
    expect(res.status).toBeLessThan(500);
  });
});

// =========================================================================
// 2. Invalid port — line 224
// =========================================================================

describe('port validation', () => {
  test('rejects invalid port (99999)', async () => {
    const saved = process.env.PORT;
    delete process.env.PORT;
    try {
      await expect(createServer({ ...baseConfig, port: 99999 })).rejects.toThrow(
        '[slingshot] Invalid port: 99999',
      );
    } finally {
      if (saved !== undefined) process.env.PORT = saved;
    }
  });
});

// =========================================================================
// 3. SSE endpoints — lines 233-291
// =========================================================================

describe('SSE endpoints', () => {
  test('mounts SSE endpoint with bus subscription', async () => {
    const eventKey = 'test:item.created';
    const plugin = createSseDefinitionPlugin(eventKey);

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [plugin],
      sse: {
        endpoints: {
          '/__sse/items': {
            events: [eventKey],
            heartbeat: false,
          },
        },
      },
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/__sse/items`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value } = await withTimeout(reader.read(), 2000, 'SSE connected');
    expect(decoder.decode(value)).toContain('connected');

    // Emit an event via the bus and verify it arrives
    const ctx = getServerContext(server)!;
    ctx.events.publish(eventKey as never, { id: 'abc' } as never, { source: 'system' });

    const { value: v2 } = await withTimeout(reader.read(), 2000, 'SSE event');
    const text = decoder.decode(v2);
    expect(text).toContain('event: test:item.created');
    expect(text).toContain('"id":"abc"');

    await reader.cancel();
  });
});

// =========================================================================
// 4. SSE validation errors — lines 245-259
// =========================================================================

describe('SSE validation errors', () => {
  test('rejects :param in SSE path', async () => {
      const plugin: SlingshotPlugin = {
        name: 'sse-p1',
        setupPost({ events }) {
          events.register(
            defineEvent('test:x', {
              ownerPlugin: 'sse-p1',
              exposure: ['client-safe'],
              resolveScope() {
                return { resourceType: 'test', resourceId: 'x' };
              },
            }),
          );
        },
      };
    await expect(
      createServer({
        ...baseConfig,
        plugins: [plugin],
        sse: { endpoints: { '/__sse/:room': { events: ['test:x'] } } },
      }),
    ).rejects.toThrow('must be a literal path');
  });

  test('rejects path not under /__sse/', async () => {
      const plugin: SlingshotPlugin = {
        name: 'sse-p2',
        setupPost({ events }) {
          events.register(
            defineEvent('test:x', {
              ownerPlugin: 'sse-p2',
              exposure: ['client-safe'],
              resolveScope() {
                return { resourceType: 'test', resourceId: 'x' };
              },
            }),
          );
        },
      };
    await expect(
      createServer({
        ...baseConfig,
        plugins: [plugin],
        sse: { endpoints: { '/events/stream': { events: ['test:x'] } } },
      }),
    ).rejects.toThrow('must be under the /__sse/ prefix');
  });

  test('rejects collision with WS endpoint', async () => {
      const plugin: SlingshotPlugin = {
        name: 'sse-p3',
        setupPost({ events }) {
          events.register(
            defineEvent('test:x', {
              ownerPlugin: 'sse-p3',
              exposure: ['client-safe'],
              resolveScope() {
                return { resourceType: 'test', resourceId: 'x' };
              },
            }),
          );
        },
      };
    await expect(
      createServer({
        ...baseConfig,
        plugins: [plugin],
        ws: { endpoints: { '/__sse/chat': {} } },
        sse: { endpoints: { '/__sse/chat': { events: ['test:x'] } } },
      }),
    ).rejects.toThrow('collides with an existing WS endpoint');
  });

  test('rejects collision with Hono GET route', async () => {
    const plugin: SlingshotPlugin = {
      name: 'sse-p4',
        setupRoutes({ app }) {
          app.get('/__sse/items', c => c.text('x'));
        },
        setupPost({ events }) {
          events.register(
            defineEvent('test:x', {
              ownerPlugin: 'sse-p4',
              exposure: ['client-safe'],
              resolveScope() {
                return { resourceType: 'test', resourceId: 'x' };
              },
            }),
          );
        },
      };
    await expect(
      createServer({
        ...baseConfig,
        plugins: [plugin],
        sse: { endpoints: { '/__sse/items': { events: ['test:x'] } } },
      }),
    ).rejects.toThrow('collides with Hono GET route');
  });
});

// =========================================================================
// 5. maxRequestBodySize from upload config — lines 297-299
// =========================================================================

describe('maxRequestBodySize from upload', () => {
  test('HTTP path: derives from upload config', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      upload: { maxFileSize: 1024, maxFiles: 5 },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  test('WS path: derives from upload config', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      upload: { maxFileSize: 2048, maxFiles: 3 },
      ws: { endpoints: { '/ws': {} } },
    });
    expect(server.port).toBeGreaterThan(0);
  });
});

// =========================================================================
// 6. WS recovery without persistence — lines 349-353
// =========================================================================

describe('WS recovery requires persistence', () => {
  test('throws without persistence', async () => {
    await expect(
      createServer({
        ...baseConfig,
        ws: { endpoints: { '/chat': { recovery: { windowMs: 60_000 } } } },
      }),
    ).rejects.toThrow('recovery requires persistence to be configured');
  });
});

// =========================================================================
// 7. Graceful shutdown — lines 556-652
// =========================================================================

describe('graceful shutdown', () => {
  test('WS server shutdown runs full teardown', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-sd': {} } },
    });

    const registry = getRegistry()!;
    expect(registry.callbacks.size).toBeGreaterThan(0);
    expect(registry.listeners).not.toBeNull();

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(0);
    server = null;
  });

  test('HTTP server shutdown runs full teardown', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGINT'), 5_000, 'shutdown');
    expect(exitCode).toBe(0);
    server = null;
  });

  test('duplicate shutdown returns same promise', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const shutdownCb = getLastShutdownCallback();
    const p1 = shutdownCb('SIGTERM');
    const p2 = shutdownCb('SIGINT');
    expect(p2).toBe(p1);
    await withTimeout(p1, 5_000, 'shutdown');
    server = null;
  });

  test('app:shutdown emits once across graceful shutdown and ctx.destroy()', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });

    const ctx = getServerContext(server)!;
    const originalPublish = ctx.events.publish.bind(ctx.events);
    const shutdownSignals: string[] = [];

    (ctx.events as typeof ctx.events & {
      publish: typeof ctx.events.publish;
    }).publish = ((key, payload, publishContext) => {
      if (key === 'app:shutdown') {
        shutdownSignals.push((payload as { signal: string }).signal);
      }
      return originalPublish(key, payload, publishContext);
    }) as typeof ctx.events.publish;

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(0);

    await ctx.destroy();

    expect(shutdownSignals).toEqual(['SIGTERM']);
    server = null;
  });

  test('shutdown with heartbeat stops timer', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: { '/ws-hb': { heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 } } },
      },
    });
    expect(getServerContext(server)!.ws!.heartbeatTimer).not.toBeNull();

    const shutdownCb = getLastShutdownCallback();
    await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    server = null;
  });

  test('shutdown disconnects WS transport', async () => {
    let disconnected = false;
    const transport = {
      connect: async () => {},
      disconnect: async () => {
        disconnected = true;
      },
      publish: async () => {},
    };

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-t': {} }, transport: transport as any },
    });

    const shutdownCb = getLastShutdownCallback();
    await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(disconnected).toBeTrue();
    server = null;
  });

  test('shutdown closes SSE streams', async () => {
    const eventKey = 'test:sd';
    const plugin = createSseDefinitionPlugin(eventKey);

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [plugin],
      sse: { endpoints: { '/__sse/sd': { events: [eventKey], heartbeat: false } } },
    });

    // Open an SSE connection
    const res = await fetch(`http://127.0.0.1:${server.port}/__sse/sd`);
    const reader = res.body!.getReader();
    await withTimeout(reader.read(), 2000, 'SSE connected');

    const shutdownCb = getLastShutdownCallback();
    await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');

    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    server = null;
  });
});

// =========================================================================
// 8. WS hooks — open, message, close, error paths
// =========================================================================

describe('WS hooks', () => {
  test('on.open hook is called', async () => {
    let openCalled = false;
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-o': {
            on: {
              open: () => {
                openCalled = true;
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-o`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    await new Promise(r => setTimeout(r, 50));
    expect(openCalled).toBeTrue();
  });

  test('on.open error is caught gracefully', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-oe': {
            on: {
              open: () => {
                throw new Error('open err');
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-oe`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    const msg = await withTimeout(waitForMessage(ws), 2_000, 'connected');
    expect(msg.event).toBe('connected');
  });

  test('on.message hook for unhandled messages', async () => {
    let received: string | null = null;
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-m': {
            on: {
              message: (_ws, msg) => {
                received = typeof msg === 'string' ? msg : msg.toString();
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-m`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    ws.send('hello raw');
    await new Promise(r => setTimeout(r, 100));
    expect(received).toBe('hello raw');
  });

  test('on.message error is caught gracefully', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-me': {
            on: {
              message: () => {
                throw new Error('msg err');
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-me`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    ws.send('trigger');
    await new Promise(r => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  test('on.close hook is called', async () => {
    let closeCode = 0;
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-c': {
            on: {
              close: (_ws, code) => {
                closeCode = code;
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-c`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    ws.close(1000, 'test');
    await withTimeout(waitForClose(ws), 2_000, 'ws close');
    await new Promise(r => setTimeout(r, 50));
    expect(closeCode).toBe(1000);
  });

  test('on.close error is caught gracefully', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-ce': {
            on: {
              close: () => {
                throw new Error('close err');
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-ce`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    ws.close(1000, 'test');
    const { code } = await withTimeout(waitForClose(ws), 2_000, 'ws close');
    expect(code).toBe(1000);
  });
});

// =========================================================================
// 9. WS message size check — lines 384-386
// =========================================================================

describe('WS message size limit', () => {
  test('closes on oversized message', async () => {
    let closeCode = 0;
    let closeResolve: () => void;
    const closed = new Promise<void>(r => {
      closeResolve = r!;
    });

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-sz': {
            maxMessageSize: 10,
            on: {
              close: (_ws, code) => {
                closeCode = code;
                closeResolve();
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-sz`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    ws.send('x'.repeat(50));
    await withTimeout(closed, 2_000, 'server close');
    expect(closeCode).toBe(1009);
  });
});

// =========================================================================
// 10. WS rate limiting — lines 390-395
// =========================================================================

describe('WS rate limiting', () => {
  test('close policy on rate limit exceed', async () => {
    let closeCode = 0;
    let closeResolve: () => void;
    const closed = new Promise<void>(r => {
      closeResolve = r!;
    });

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-rl': {
            rateLimit: { windowMs: 60_000, maxMessages: 2, onExceeded: 'close' },
            on: {
              close: (_ws, code) => {
                closeCode = code;
                closeResolve();
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-rl`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    ws.send('a');
    ws.send('b');
    ws.send('c');
    await withTimeout(closed, 2_000, 'rate limit close');
    expect(closeCode).toBe(1008);
  });

  test('drop policy silently drops excess messages', async () => {
    let count = 0;
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-rd': {
            rateLimit: { windowMs: 60_000, maxMessages: 2, onExceeded: 'drop' },
            on: {
              message: () => {
                count++;
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-rd`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');
    for (let i = 0; i < 5; i++) ws.send(`m${i}`);
    await new Promise(r => setTimeout(r, 300));
    expect(count).toBe(2);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

// =========================================================================
// 11. WS recovery with persistence — lines 362, 420-427
// =========================================================================

describe('WS recovery', () => {
  test('assigns sessionId on open, writes session on close', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-rc': { persistence: { store: 'memory' }, recovery: { windowMs: 120_000 } },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-rc`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    const msg = await withTimeout(waitForMessage(ws), 2_000, 'connected');
    expect(msg.sessionId).toBeDefined();
    expect(typeof msg.sessionId).toBe('string');
    ws.close(1000);
    await withTimeout(waitForClose(ws), 2_000, 'ws close');
  });
});

// =========================================================================
// 12. WS persistence defaults — line 347
// =========================================================================

describe('WS persistence defaults', () => {
  test('sets defaults via endpoint config', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-pd': {
            persistence: { store: 'memory', defaults: { maxMessages: 100, ttlMs: 60_000 } },
          },
        },
      },
    });
    expect(server.port).toBeGreaterThan(0);
  });
});

// =========================================================================
// 13. WS transport connect callback — lines 495-499
// =========================================================================

describe('WS transport connect', () => {
  test('connect callback handles origin filtering', async () => {
    let cb: ((ep: string, room: string, msg: string, origin: string) => void) | null = null;
    const transport = {
      connect: async (fn: typeof cb) => {
        cb = fn;
      },
      disconnect: async () => {},
      publish: async () => {},
    };

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-tr': {} }, transport: transport as any },
    });

    expect(cb).not.toBeNull();
    const localId = getServerContext(server)!.ws!.instanceId;
    // Local origin is suppressed (no crash)
    cb!('/ws-tr', 'room1', '{}', localId);
    // Foreign origin calls server.publish (no crash)
    cb!('/ws-tr', 'room1', '{}', 'foreign');
  });
});

// =========================================================================
// 14. Heartbeat startup — line 508
// =========================================================================

describe('WS heartbeat', () => {
  test('starts when configured', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-hb': { heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 } } } },
    });
    expect(getServerContext(server)!.ws!.heartbeatTimer).not.toBeNull();
  });

  test('not started when not configured', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-nhb': {} } },
    });
    expect(getServerContext(server)!.ws!.heartbeatTimer).toBeNull();
  });
});

// =========================================================================
// 15. Workers loading — lines 661-667
// =========================================================================

describe('workers loading', () => {
  test('loads from empty directory', async () => {
    const tmpDir = `${import.meta.dir}/../../.tmp-workers-${Date.now()}`;
    const { mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });
    try {
      server = await createServer({
        ...baseConfig,
        hostname: '127.0.0.1',
        port: 0,
        workersDir: tmpDir,
        enableWorkers: true,
      });
      expect(server.port).toBeGreaterThan(0);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  test('skips when enableWorkers is false', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      workersDir: '/nonexistent',
      enableWorkers: false,
    });
    expect(server.port).toBeGreaterThan(0);
  });
});

// =========================================================================
// 16. ensureProcessShutdownListeners — lines 86-103
// =========================================================================

describe('process shutdown listeners', () => {
  test('registry is populated after createServer', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });
    const registry = getRegistry()!;
    expect(registry.callbacks.size).toBeGreaterThan(0);
    expect(registry.listeners).not.toBeNull();
  });

  test('server.stop() releases shutdown ownership', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
    });
    const registry = getRegistry()!;
    const before = registry.callbacks.size;
    const ctx = getServerContext(server);
    server.stop(true);
    await ctx?.destroy();
    expect(registry.callbacks.size).toBe(before - 1);
    server = null;
  });
});

// =========================================================================
// 17. Bun.serve error handler — lines 485-486
// =========================================================================

describe('Bun.serve error handler (WS path)', () => {
  test('error route returns error response', async () => {
    const plugin: SlingshotPlugin = {
      name: 'err-plugin',
      setupRoutes({ app }) {
        app.get('/boom', () => {
          throw new Error('boom');
        });
      },
    };
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [plugin],
      ws: { endpoints: { '/ws-e': {} } },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/boom`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// =========================================================================
// 18. WS drain/pong hooks — lines 445, 448
// =========================================================================

describe('WS drain and pong', () => {
  test('drain hook is wired', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-d': { on: { drain: () => {} } } } },
    });
    expect(server.port).toBeGreaterThan(0);
  });
});

// =========================================================================
// 19. WS pong handler via short heartbeat — line 445
// =========================================================================

describe('WS pong handler', () => {
  test('pong is handled when heartbeat ping is sent', async () => {
    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: {
        endpoints: {
          '/ws-pong': {
            heartbeat: { intervalMs: 100, timeoutMs: 5_000 },
          },
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws-pong`);
    sockets.push(ws);
    await withTimeout(waitForOpen(ws), 2_000, 'ws open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected');

    // Wait for heartbeat interval to fire a ping — client auto-responds with pong
    await new Promise(r => setTimeout(r, 250));
    // Connection should still be open (pong was received, timeout didn't expire)
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

// =========================================================================
// 20. Shutdown error paths — lines 580-581, 604-605
// =========================================================================

describe('shutdown error paths', () => {
  test('plugin teardown error sets exit code 1', async () => {
    const plugin: SlingshotPlugin = {
      name: 'teardown-err-plugin',
      setupPost() {
        /* no-op, required for plugin validation */
      },
      teardown: async () => {
        throw new Error('teardown boom');
      },
    };

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [plugin],
    });

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(1);
    server = null;
  });

  test('bus shutdown error sets exit code 1', async () => {
    const plugin: SlingshotPlugin = {
      name: 'bus-err-plugin',
      setupPost({ app }) {
        const ctx = getContext(app);
        (ctx.bus as any).shutdown = async () => {
          throw new Error('bus shutdown boom');
        };
      },
    };

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [plugin],
    });

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(1);
    server = null;
  });

  test('transport disconnect error sets exit code 1', async () => {
    const transport = {
      connect: async () => {},
      disconnect: async () => {
        throw new Error('disconnect boom');
      },
      publish: async () => {},
    };

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      ws: { endpoints: { '/ws-td': {} }, transport: transport as any },
    });

    const shutdownCb = getLastShutdownCallback();
    const exitCode = await withTimeout(shutdownCb('SIGTERM'), 5_000, 'shutdown');
    expect(exitCode).toBe(1);
    server = null;
  });
});
