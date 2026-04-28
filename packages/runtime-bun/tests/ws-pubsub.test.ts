import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeServerInstance, RuntimeWebSocket } from '@lastshotlabs/slingshot-core';
import { bunRuntime } from '../src/index';

/**
 * Real-runtime WebSocket integration tests. Boots an actual Bun.serve via
 * runtime-bun's `server.listen()`, connects browser-spec WebSocket clients,
 * and exercises subscribe/unsubscribe/publish + the pong handler. No mocks.
 */

interface ConnHandle {
  url: string;
  serverWs?: RuntimeWebSocket;
  // Per-connection identity attached at upgrade time.
  id: string;
}

let server: RuntimeServerInstance | undefined;

afterEach(async () => {
  if (server) {
    try {
      // The runtime's drain awaits per-socket close handlers and then
      // races Bun's underlying stop(true) against a small grace window
      // (the Bun 1.3.11 promise can hang even after every WS is closed).
      // Our stop() promise resolves cleanly after that, so no test-side
      // race is needed.
      await server.stop(true);
    } catch {
      // best effort cleanup
    }
    server = undefined;
  }
});

/**
 * Wait for `predicate()` to be true, polling on a microtask cadence.
 * Throws if it does not become true within `timeoutMs`.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

/**
 * Open a WebSocket client and resolve once `open` fires.
 */
async function openClient(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = (ev: Event) => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      reject(new Error(`client failed to open: ${String(ev)}`));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
  return ws;
}

describe('runtime-bun websocket pub/sub', () => {
  test('publish fans out to subscribed sockets only; unsubscribe stops delivery', async () => {
    // Track open WS handles by their attached upgrade id so we can drive
    // subscribe/unsubscribe from the test (which doesn't have direct access
    // to ServerWebSocket handles).
    const handles = new Map<string, ConnHandle>();
    const messagesByClient = new Map<string, string[]>();

    const runtime = bunRuntime();
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        const url = new URL(req.url);
        const id = url.searchParams.get('id') ?? '';
        if (url.pathname === '/ws' && id) {
          const ok = server?.upgrade?.(req, { data: { id } });
          if (ok) return new Response(null, { status: 101 });
          return new Response('upgrade failed', { status: 400 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          const data = ws.data as { id: string };
          handles.set(data.id, { url: '', serverWs: ws, id: data.id });
        },
        async message(ws, msg) {
          const data = ws.data as { id: string };
          const text = typeof msg === 'string' ? msg : msg.toString('utf8');
          // Allow tests to drive subscribe / unsubscribe via the message
          // channel — keeps the test driven entirely from the client side.
          if (text.startsWith('SUB:')) {
            ws.subscribe(text.slice(4));
            ws.send(`OK:SUB:${text.slice(4)}`);
            return;
          }
          if (text.startsWith('UNSUB:')) {
            ws.unsubscribe(text.slice(6));
            ws.send(`OK:UNSUB:${text.slice(6)}`);
            return;
          }
          // Otherwise just record what each client received.
          const list = messagesByClient.get(data.id) ?? [];
          list.push(text);
          messagesByClient.set(data.id, list);
        },
        close(ws) {
          const data = ws.data as { id: string };
          handles.delete(data.id);
        },
      },
    });

    const port = server.port;
    expect(port).toBeGreaterThan(0);

    const baseUrl = `ws://127.0.0.1:${port}/ws`;

    // Connect two clients with distinct ids.
    const clientA = await openClient(`${baseUrl}?id=A`);
    const clientB = await openClient(`${baseUrl}?id=B`);

    // Capture every message received by each client (channel deliveries land
    // here too — they're forwarded by Bun straight into the message handler).
    const recvA: string[] = [];
    const recvB: string[] = [];
    clientA.addEventListener('message', (ev: MessageEvent) => recvA.push(String(ev.data)));
    clientB.addEventListener('message', (ev: MessageEvent) => recvB.push(String(ev.data)));

    await waitFor(() => handles.has('A') && handles.has('B'), 2000, 'both clients connected');

    // A subscribes to t1, B does not.
    clientA.send('SUB:t1');
    await waitFor(() => recvA.some(m => m === 'OK:SUB:t1'), 2000, 'A subscribed');

    // Server publishes to t1 — only A should receive.
    server.publish?.('t1', 'hello-t1');
    await waitFor(() => recvA.includes('hello-t1'), 2000, 'A got hello-t1');

    // B should NOT receive it. Wait a tick to ensure no late delivery.
    await new Promise(r => setTimeout(r, 100));
    expect(recvB.includes('hello-t1')).toBe(false);

    // A unsubscribes; subsequent publish is silently dropped for A.
    clientA.send('UNSUB:t1');
    await waitFor(() => recvA.some(m => m === 'OK:UNSUB:t1'), 2000, 'A unsubscribed');

    const aLenBefore = recvA.length;
    server.publish?.('t1', 'after-unsub');
    await new Promise(r => setTimeout(r, 100));
    // Only the OK:UNSUB:* ack was added before publish; nothing new from publish.
    expect(recvA.slice(aLenBefore)).toEqual([]);
    expect(recvB.includes('after-unsub')).toBe(false);

    clientA.close();
    clientB.close();
    await waitFor(() => handles.size === 0, 2000, 'both clients closed');
  });

  test('pong handler fires when client responds to a server ping', async () => {
    let pongCount = 0;
    let openWs: RuntimeWebSocket | undefined;
    let serverClosed = false;

    const runtime = bunRuntime();
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          const ok = server?.upgrade?.(req, { data: {} });
          if (ok) return new Response(null, { status: 101 });
        }
        return new Response('nope', { status: 404 });
      },
      websocket: {
        open(ws) {
          openWs = ws;
        },
        message() {},
        close() {
          serverClosed = true;
        },
        pong() {
          pongCount += 1;
        },
      },
    });

    const port = server.port;
    const client = await openClient(`ws://127.0.0.1:${port}/ws`);
    await waitFor(() => openWs !== undefined, 2000, 'server saw open');

    // Send a ping from the server. The browser-spec WebSocket client replies
    // with a pong frame automatically, which triggers the pong handler.
    openWs!.ping();
    await waitFor(() => pongCount >= 1, 2000, 'pong handler invoked');
    expect(pongCount).toBeGreaterThanOrEqual(1);

    // Tear down the client end first so afterEach's server.stop(true) has
    // nothing to wait for on the wire.
    const clientClosed = new Promise<void>(resolve => {
      client.addEventListener('close', () => resolve());
    });
    client.close();
    await Promise.race([clientClosed, new Promise(r => setTimeout(r, 1000))]);
    await waitFor(() => serverClosed, 2000, 'server saw close');
  });
});

describe('runtime-bun graceful drain on stop()', () => {
  test('stop(true) drains active websockets with deterministic 1001 + reason', async () => {
    // The runtime's drain issues `ws.close(1001, 'Server shutting down')`
    // on each tracked socket and AWAITS each per-socket close handler
    // before kicking off Bun's stop(true). That ordering flushes the 1001
    // close frame before Bun has a chance to collapse it into a 1006, so
    // we can assert deterministically on 1001 + the runtime reason.
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let serverOpen = false;

    const runtime = bunRuntime();
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          const ok = server?.upgrade?.(req, { data: {} });
          if (ok) return new Response(null, { status: 101 });
        }
        return new Response('ok');
      },
      websocket: {
        open() {
          serverOpen = true;
        },
        message() {},
        close(_ws, code, reason) {
          closeEvents.push({ code, reason });
        },
      },
    });

    const port = server.port;
    const client = await openClient(`ws://127.0.0.1:${port}/ws`);
    await waitFor(() => serverOpen, 2000, 'server saw open');
    // Yield ticks so Bun fully settles the upgrade handshake before
    // issuing the drain — without this, ws.close(1001) races internal
    // upgrade bookkeeping in some Bun builds.
    await new Promise(r => setTimeout(r, 50));
    const clientClosed = new Promise<number>(resolve => {
      client.addEventListener('close', (ev: CloseEvent) => resolve(ev.code));
    });

    // stop(true) returns a Promise that should resolve cleanly now that
    // the runtime owns the drain (no test-side race needed).
    await server.stop(true);

    // The drain awaits the close handler internally, so by the time
    // stop() resolves the close event has been recorded with the
    // runtime-supplied code and reason.
    expect(closeEvents).toHaveLength(1);
    expect(closeEvents[0]?.code).toBe(1001);
    expect(closeEvents[0]?.reason).toBe('Server shutting down');

    const clientCode = await Promise.race([
      clientClosed,
      new Promise<number>(r => setTimeout(() => r(-1), 2000)),
    ]);
    expect(clientCode).not.toBe(-1);
  });

  test('stop(true) completes via timeout fallback when close handler stalls', async () => {
    // A misbehaving close handler that ignores the close event (hangs)
    // should not block drain forever. After wsCloseTimeoutMs elapses the
    // runtime moves on and force-stops the underlying server.
    let serverOpen = false;
    let stallRelease!: () => void;
    const stalled = new Promise<void>(r => {
      stallRelease = r;
    });

    const runtime = bunRuntime({ wsCloseTimeoutMs: 200 });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          const ok = server?.upgrade?.(req, { data: {} });
          if (ok) return new Response(null, { status: 101 });
        }
        return new Response('ok');
      },
      websocket: {
        open() {
          serverOpen = true;
        },
        message() {},
        async close() {
          // Block forever (until the test releases) so the per-socket
          // close-handler deferred can't resolve. The drain must rely on
          // its timeout to make progress.
          await stalled;
        },
      },
    });

    const port = server.port;
    const client = await openClient(`ws://127.0.0.1:${port}/ws`);
    await waitFor(() => serverOpen, 2000, 'server saw open');
    await new Promise(r => setTimeout(r, 50));

    // Drain should still complete — bounded by wsCloseTimeoutMs (200 ms)
    // plus the small Bun stop grace window. Anything above ~1 s would be
    // a regression.
    const t0 = Date.now();
    await server.stop(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1500);
    expect(elapsed).toBeGreaterThanOrEqual(200);

    // Release the stalled handler so the test process doesn't leak it.
    stallRelease();
    // Quietly tear down the client socket on the test side; the server
    // is already stopped.
    try {
      client.close();
    } catch {
      // ignore
    }
  });

  test('after stop(true), new connections are rejected', async () => {
    const runtime = bunRuntime();
    const local = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
    });
    const port = local.port;

    // Sanity check — server is reachable before stop.
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    expect(ok.status).toBe(200);

    await local.stop(true);

    // After stop(true), the OS port is released. A new fetch should fail
    // (connection refused) rather than succeed.
    let connectFailed = false;
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      connectFailed = true;
    }
    expect(connectFailed).toBe(true);
  });

  test('stop() without closeActiveConnections lets in-flight HTTP requests finish', async () => {
    let release!: () => void;
    const inflight = new Promise<void>(r => {
      release = r;
    });
    let handlerFinished = false;

    const runtime = bunRuntime();
    const local = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        await inflight;
        handlerFinished = true;
        return new Response('done');
      },
    });
    const port = local.port;

    // Kick off an in-flight request; do NOT await it yet.
    const pending = fetch(`http://127.0.0.1:${port}/`);

    // Give the request a moment to land in the handler.
    await new Promise(r => setTimeout(r, 50));

    // Begin graceful stop (no force-close). The promise should not resolve
    // until the in-flight handler completes.
    const stopPromise = local.stop();

    // Release the handler; then both stop() and the fetch should complete.
    release();
    const res = await pending;
    await stopPromise;

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('done');
    expect(handlerFinished).toBe(true);
  });
});
