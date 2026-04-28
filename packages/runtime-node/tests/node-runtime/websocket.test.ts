import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket as WsClient } from 'ws';
import type { RuntimeServerInstance } from '@lastshotlabs/slingshot-core';
import { nodeRuntime } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The Node runtime's fetch handler must signal @hono/node-server that the
 * response was already sent (WS upgrade took ownership of the socket).
 * @hono/node-server skips all outgoing writes when this header is present.
 */
const ALREADY_SENT = new Response(null, { headers: { 'x-hono-already-sent': 'true' } });

/**
 * Create a WsClient connected to `url`. Registers a message buffer and an
 * error no-op immediately (before `open` fires) so no messages or errors are
 * missed or unhandled between open and the first `nextMessage` call.
 *
 * Returns `{ ws, nextMessage }` where `nextMessage()` pops the oldest buffered
 * message string, waiting for the next one if the buffer is empty.
 */
function createBufferedClient(url: string): Promise<{
  ws: WsClient;
  nextMessage: () => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    const buffer: string[] = [];
    const waiting: Array<(msg: string) => void> = [];

    // Register before open so messages sent during the open handler are buffered.
    ws.on('message', (data: unknown) => {
      const str = Buffer.isBuffer(data) ? data.toString() : String(data);
      if (waiting.length > 0) {
        waiting.shift()!(str);
      } else {
        buffer.push(str);
      }
    });

    // Suppress unhandled error events after open (e.g. on server stop).
    ws.on('error', () => {});

    const timeout = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), 4000);

    ws.once('open', () => {
      clearTimeout(timeout);
      const nextMessage = (): Promise<string> =>
        new Promise<string>((res, rej) => {
          if (buffer.length > 0) {
            res(buffer.shift()!);
            return;
          }
          const t = setTimeout(() => rej(new Error('nextMessage timeout')), 4000);
          waiting.push(msg => {
            clearTimeout(t);
            res(msg);
          });
        });
      resolve({ ws, nextMessage });
    });

    ws.once('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Gracefully close a WsClient and wait for the 'close' event. */
function closeWs(ws: WsClient): Promise<void> {
  return new Promise<void>(resolve => {
    if (ws.readyState === WsClient.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtime-node WebSocket', () => {
  let server: RuntimeServerInstance | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop(true);
      server = null;
    }
  });

  // -------------------------------------------------------------------------
  // 1. open fires, message echoes, close fires on disconnect
  // -------------------------------------------------------------------------

  test('open fires, message echoes, close fires on disconnect', async () => {
    const runtime = nodeRuntime();
    const events: string[] = [];
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          events.push('open');
          ws.send('ready');
        },
        message(ws, msg) {
          events.push(`msg:${msg}`);
          ws.send(`echo:${msg}`);
        },
        close() {
          events.push('close');
        },
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: { uid: 99 } });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    try {
      // Server sends 'ready' in the open handler
      expect(await nextMessage()).toBe('ready');
      expect(events).toContain('open');

      // Send a message and wait for the echo
      client.send('hello');
      expect(await nextMessage()).toBe('echo:hello');
      expect(events).toContain('msg:hello');
    } finally {
      await closeWs(client);
      // Give server close handler time to fire
      await new Promise<void>(r => setTimeout(r, 80));
    }

    expect(events).toContain('close');
  });

  // -------------------------------------------------------------------------
  // 2. data payload forwarded via upgrade() is accessible in open handler
  // -------------------------------------------------------------------------

  test('data payload forwarded via upgrade() is accessible in open handler', async () => {
    const runtime = nodeRuntime();
    let receivedData: unknown;
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          receivedData = ws.data;
          ws.send('ack');
        },
        message() {},
        close() {},
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: { userId: 'alice', role: 'admin' } });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    try {
      expect(await nextMessage()).toBe('ack');
      expect(receivedData).toEqual({ userId: 'alice', role: 'admin' });
    } finally {
      await closeWs(client);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Channel pub/sub — publish only reaches subscribers on that channel
  // -------------------------------------------------------------------------

  test('publish only delivers to clients subscribed to that channel', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          const ch = (ws.data as { channel: string }).channel;
          ws.subscribe(ch);
          ws.send(`sub:${ch}`);
        },
        message() {},
        close() {},
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          const url = new URL(req.url);
          const channel = url.searchParams.get('ch') ?? 'default';
          inst.upgrade(req, { data: { channel } });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    // Create buffered clients so subscription confirmations are never missed
    const [a, b] = await Promise.all([
      createBufferedClient(`ws://127.0.0.1:${server.port}/?ch=channelA`),
      createBufferedClient(`ws://127.0.0.1:${server.port}/?ch=channelB`),
    ]);

    // Track all messages received by each client independently
    const bReceived: string[] = [];
    b.ws.on('message', (data: unknown) => {
      // Note: createBufferedClient already registered a message handler that buffers
      // into the nextMessage queue. This second listener is additive.
      bReceived.push(Buffer.isBuffer(data) ? data.toString() : String(data));
    });

    try {
      // Receive subscription confirmations
      expect(await a.nextMessage()).toBe('sub:channelA');
      expect(await b.nextMessage()).toBe('sub:channelB');

      // Publish to channelA — channelA client receives it
      const aPub = a.nextMessage();
      server.publish('channelA', 'msg-for-A');
      expect(await aPub).toBe('msg-for-A');

      // channelB client must NOT receive the channelA publish
      await new Promise<void>(r => setTimeout(r, 100));
      const bAfterChannelAPublish = bReceived.filter(m => m !== 'sub:channelB');
      expect(bAfterChannelAPublish).toHaveLength(0);

      // Publish to channelB — channelB client receives it
      const bPub = b.nextMessage();
      server.publish('channelB', 'msg-for-B');
      expect(await bPub).toBe('msg-for-B');
    } finally {
      await closeWs(a.ws);
      await closeWs(b.ws);
      await new Promise<void>(r => setTimeout(r, 50));
    }
  });

  // -------------------------------------------------------------------------
  // 4. Upgrade timeout — socket destroyed when upgrade() is never called
  // -------------------------------------------------------------------------

  test('upgrade timeout destroys the socket when upgrade() is never called', async () => {
    const runtime = nodeRuntime();

    server = await runtime.server.listen({
      port: 0,
      upgradeTimeoutMs: 100,
      websocket: {
        open() {},
        message() {},
        close() {},
      },
      // Never calls upgrade() — the timeout should destroy the socket
      fetch() {
        return new Response('ignored');
      },
    });

    const result = await new Promise<string>(resolve => {
      const ws = new WsClient(`ws://127.0.0.1:${server!.port}/`);

      const hardTimeout = setTimeout(() => {
        ws.terminate();
        resolve('hard-timeout');
      }, 800);

      const done = (outcome: string) => {
        clearTimeout(hardTimeout);
        resolve(outcome);
      };

      // Use permanent handlers (ws.on) so subsequent events don't go unhandled.
      ws.on('open', () => done('opened'));
      ws.on('error', () => done('error'));
      ws.on('close', code => done(`closed:${code}`));
    });

    // Should never have successfully opened
    expect(result).not.toBe('opened');
    expect(result).not.toBe('hard-timeout');
  });

  // -------------------------------------------------------------------------
  // 5. async message handler error is logged and connection stays open
  // -------------------------------------------------------------------------

  test('async message handler rejection is logged and connection stays open', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));

    try {
      server = await runtime.server.listen({
        port: 0,
        websocket: {
          open(ws) {
            ws.send('ready');
          },
          // async handler — the rejected promise is caught by the runtime's .catch()
          async message(_ws, msg) {
            if (msg === 'throw') throw new Error('deliberate-message-error');
          },
          close() {},
        },
        fetch(req) {
          if (req.headers.get('upgrade') === 'websocket') {
            inst.upgrade(req, { data: null });
            return ALREADY_SENT;
          }
          return new Response('ok');
        },
      });
      inst = server;

      const { ws: client, nextMessage } = await createBufferedClient(
        `ws://127.0.0.1:${server.port}/`,
      );
      try {
        expect(await nextMessage()).toBe('ready');

        client.send('throw');
        // Allow async rejection handling to complete
        await new Promise<void>(r => setTimeout(r, 80));

        // Error was logged with the 'message' phase in the log line
        expect(logged.some(line => line.includes('message'))).toBe(true);

        // Connection is still alive
        expect(client.readyState).toBe(WsClient.OPEN);
      } finally {
        await closeWs(client);
        await new Promise<void>(r => setTimeout(r, 30));
      }
    } finally {
      console.error = origError;
    }
  });

  // -------------------------------------------------------------------------
  // 6. async close handler rejection is caught and logged
  // -------------------------------------------------------------------------

  test('async close handler rejection is caught and logged', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));

    try {
      server = await runtime.server.listen({
        port: 0,
        websocket: {
          open(ws) {
            ws.send('ready');
          },
          message() {},
          // async handler — the rejected promise is caught by the runtime's .catch()
          async close() {
            throw new Error('deliberate-close-error');
          },
        },
        fetch(req) {
          if (req.headers.get('upgrade') === 'websocket') {
            inst.upgrade(req, { data: null });
            return ALREADY_SENT;
          }
          return new Response('ok');
        },
      });
      inst = server;

      const { ws: client, nextMessage } = await createBufferedClient(
        `ws://127.0.0.1:${server.port}/`,
      );
      expect(await nextMessage()).toBe('ready');

      await closeWs(client);
      await new Promise<void>(r => setTimeout(r, 120));

      expect(logged.some(line => line.includes('close'))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  // -------------------------------------------------------------------------
  // 7. upgrade() returns false when no websocket handler is configured
  // -------------------------------------------------------------------------

  test('upgrade() returns false when no websocket handler is configured', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      fetch(req) {
        // Call upgrade() on a plain HTTP request (no 'sec-websocket-key' header,
        // no wss configured) — must return false without throwing.
        const result = inst.upgrade(req, { data: null });
        return new Response(`upgrade-result:${String(result)}`);
      },
    });
    inst = server;

    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await res.text()).toBe('upgrade-result:false');
  });

  // -------------------------------------------------------------------------
  // 8. unsubscribe stops a client from receiving further channel messages
  // -------------------------------------------------------------------------

  test('unsubscribe stops a client from receiving further channel messages', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('news');
          ws.send('subscribed');
        },
        message(ws, msg) {
          if (msg === 'unsub') {
            ws.unsubscribe('news');
            ws.send('unsubscribed');
          }
        },
        close() {},
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: null });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    try {
      expect(await nextMessage()).toBe('subscribed');

      // Publish while subscribed — client receives it
      server.publish('news', 'breaking-news');
      expect(await nextMessage()).toBe('breaking-news');

      // Unsubscribe
      client.send('unsub');
      expect(await nextMessage()).toBe('unsubscribed');

      // Publish after unsubscribe — client must NOT receive it
      server.publish('news', 'after-unsub');
      const noMsg = await Promise.race([
        nextMessage().then(() => 'received' as const),
        new Promise<'nothing'>(r => setTimeout(() => r('nothing'), 150)),
      ]);
      expect(noMsg).toBe('nothing');
    } finally {
      await closeWs(client);
      await new Promise<void>(r => setTimeout(r, 30));
    }
  });

  // -------------------------------------------------------------------------
  // 9. pong handler fires when client responds to server ping
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 10. Heartbeat timer cleanup — no callbacks after server stop
  // -------------------------------------------------------------------------

  test('heartbeat sweeper does not fire after server stop and immediate WS close', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;
    let pingsReceived = 0;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        // Aggressive heartbeat — 1 s minimum interval per runtime, mapped from
        // idleTimeout/2. We use idleTimeout=2 so the first sweep fires at t=1s.
        idleTimeout: 2,
        open(ws) {
          ws.send('ready');
        },
        message() {},
        close() {},
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: null });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client } = await createBufferedClient(`ws://127.0.0.1:${server.port}/`);
    // Track server-driven pings — if the heartbeat sweeper fires after stop,
    // these increments would happen even though the socket is closed.
    client.on('ping', () => {
      pingsReceived += 1;
    });

    // Close the WS immediately and stop the server before any heartbeat sweep
    // had a chance to fire (interval=1s, we wait <50ms below).
    await closeWs(client);

    const stoppedAt = Date.now();
    await server.stop(true);
    server = null;

    // Wait past the heartbeat interval — if the late-firing guard didn't work,
    // the sweep would observe the (now-empty) `allSockets` and at worst
    // attempt to sweep stale entries. We assert no exceptions are thrown and
    // no pings are received past stop.
    await new Promise<void>(r => setTimeout(r, 1500 - (Date.now() - stoppedAt)));

    expect(pingsReceived).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. Per-socket cleanup runs once even when both `close` and `error` fire
  // -------------------------------------------------------------------------

  test('per-socket cleanup is idempotent across close+error events', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;
    let closeCalls = 0;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.send('ready');
        },
        message() {},
        close() {
          closeCalls += 1;
        },
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: null });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    expect(await nextMessage()).toBe('ready');

    // Force an abrupt close so `error` may fire alongside `close`. We use
    // `terminate()` which drops the socket immediately and triggers the
    // server-side close event with code 1006.
    client.terminate();
    await new Promise<void>(r => setTimeout(r, 100));

    // Even if both `close` and `error` fired on the server-side ws instance,
    // the user's close handler must run exactly once.
    expect(closeCalls).toBe(1);
  });

  test('pong handler fires when client responds to server ping', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;
    let serverWs: import('@lastshotlabs/slingshot-core').RuntimeWebSocket | null = null;
    let pongReceived = false;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          serverWs = ws;
          ws.send('ready');
        },
        message() {},
        close() {},
        pong() {
          pongReceived = true;
        },
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: null });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    try {
      expect(await nextMessage()).toBe('ready');

      // Server pings — ws client (ws npm package) auto-replies with a pong frame
      serverWs!.ping();
      // Allow the pong round-trip to complete
      await new Promise<void>(r => setTimeout(r, 100));

      expect(pongReceived).toBe(true);
    } finally {
      await closeWs(client);
      await new Promise<void>(r => setTimeout(r, 30));
    }
  });
});
