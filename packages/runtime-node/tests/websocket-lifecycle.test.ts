import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket as WsClient } from 'ws';
import type { RuntimeServerInstance } from '@lastshotlabs/slingshot-core';
import { nodeRuntime } from '../src/index';

/**
 * Helper: create a WsClient with a buffered message queue.
 */
function createBufferedClient(url: string): Promise<{
  ws: WsClient;
  nextMessage: () => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    const buffer: string[] = [];
    const waiting: Array<(msg: string) => void> = [];
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    ws.on('message', (data: unknown) => {
      const str = Buffer.isBuffer(data) ? data.toString() : String(data);
      if (waiting.length > 0) {
        waiting.shift()!(str);
      } else {
        buffer.push(str);
      }
    });
    ws.on('error', () => {});

    function cleanup() {
      clearTimeout(timeout);
      ws.removeListener('error', onConnectError);
      ws.removeListener('close', onCloseBeforeOpen);
    }
    function fail(err: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      ws.terminate();
      reject(err);
    }
    function onConnectError(err: Error) {
      fail(err);
    }
    function onCloseBeforeOpen(code: number, reason: Buffer) {
      fail(
        new Error(`connection closed before open: ${url} code=${code} reason=${reason.toString()}`),
      );
    }

    timeout = setTimeout(() => fail(new Error(`connect timeout: ${url}`)), 4_000);

    ws.once('open', () => {
      if (settled) return;
      settled = true;
      cleanup();
      const nextMessage = (): Promise<string> =>
        new Promise<string>((res, rej) => {
          if (buffer.length > 0) {
            res(buffer.shift()!);
            return;
          }
          const t = setTimeout(() => rej(new Error('nextMessage timeout')), 4_000);
          waiting.push(msg => {
            clearTimeout(t);
            res(msg);
          });
        });
      resolve({ ws, nextMessage });
    });

    ws.once('error', onConnectError);
    ws.once('close', onCloseBeforeOpen);
  });
}

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

async function expectNoMessage(nextMessage: () => Promise<string>, ms = 300): Promise<void> {
  const result = await Promise.race([
    nextMessage().then(() => 'received' as const),
    new Promise<'nothing'>(r => setTimeout(() => r('nothing'), ms)),
  ]);
  expect(result).toBe('nothing');
}

const ALREADY_SENT = new Response(null, { headers: { 'x-hono-already-sent': 'true' } });

describe('runtime-node WebSocket lifecycle', () => {
  let server: RuntimeServerInstance | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop(true);
      server = null;
    }
  });

  // ---------------------------------------------------------------------------
  // publishToSelf: true includes the sender
  // ---------------------------------------------------------------------------

  test('publishToSelf: true includes the sender', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        publishToSelf: true,
        open(ws) {
          ws.subscribe('self-chat');
          ws.send('ready');
        },
        message(ws, msg) {
          server.publish('self-chat', `broadcast:${msg}`);
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

      client.send('hello-self');
      expect(await nextMessage()).toBe('broadcast:hello-self');
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // Multiple channel subscription
  // ---------------------------------------------------------------------------

  test('subscribing to multiple channels receives publishes on all', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('news');
          ws.subscribe('updates');
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

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    try {
      expect(await nextMessage()).toBe('ready');

      server.publish('news', 'news-message');
      server.publish('updates', 'updates-message');

      expect(await nextMessage()).toBe('news-message');
      expect(await nextMessage()).toBe('updates-message');
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // Multiple clients on same channel all receive the message
  // ---------------------------------------------------------------------------

  test('multiple clients on same channel all receive the message', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('shared');
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

    const [a, b] = await Promise.all([
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
    ]);

    try {
      expect(await a.nextMessage()).toBe('ready');
      expect(await b.nextMessage()).toBe('ready');

      server.publish('shared', 'to-all');
      expect(await a.nextMessage()).toBe('to-all');
      expect(await b.nextMessage()).toBe('to-all');
    } finally {
      await closeWs(a.ws);
      await closeWs(b.ws);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // Client disconnect cleans up channel subscriptions
  // ---------------------------------------------------------------------------

  test('disconnecting a client removes it from all channels', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('cleanup');
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

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );
    try {
      expect(await nextMessage()).toBe('ready');

      // Disconnect the client
      await closeWs(client);
      await new Promise(r => setTimeout(r, 150));

      // Publishing to the channel after the only subscriber disconnects
      // must not throw or crash
      server.publish('cleanup', 'after-disconnect');
    } finally {
      // No need to close again
    }
  });

  // ---------------------------------------------------------------------------
  // Upgrade timeout handling
  // ---------------------------------------------------------------------------

  test('upgrade timeout with atomic cleanup does not cause double-destroy', async () => {
    const runtime = nodeRuntime();

    server = await runtime.server.listen({
      port: 0,
      upgradeTimeoutMs: 50,
      websocket: {
        open() {},
        message() {},
        close() {},
      },
      // Never call upgrade() — the timeout must fire
      fetch() {
        return new Response('ignored');
      },
    });

    const ws = new WsClient(`ws://127.0.0.1:${server!.port}/`);
    ws.on('error', () => {});
    ws.on('close', () => {});

    // Close the socket immediately before the upgrade timer fires
    await new Promise<void>(r => setTimeout(r, 10));
    ws.terminate();

    // Wait past the timeout for the timer to fire harmlessly
    await new Promise(r => setTimeout(r, 100));
  });

  // ---------------------------------------------------------------------------
  // Large WebSocket messages
  // ---------------------------------------------------------------------------

  test('large message can be sent and received over WebSocket', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.send('ready');
        },
        message(ws, msg) {
          ws.send(`echo:${msg}`);
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

      const largeMsg = 'x'.repeat(10 * 1024);
      client.send(largeMsg);
      expect(await nextMessage()).toBe(`echo:${largeMsg}`);
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // WebSocket data payload from upgrade
  // ---------------------------------------------------------------------------

  test('open handler fires with data payload from upgrade', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;
    let receivedData: unknown;

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
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // pong handler
  // ---------------------------------------------------------------------------

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

      serverWs!.ping();
      await new Promise<void>(r => setTimeout(r, 100));

      expect(pongReceived).toBe(true);
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });
});
