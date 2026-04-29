import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket as WsClient } from 'ws';
import type { RuntimeServerInstance } from '@lastshotlabs/slingshot-core';
import { nodeRuntime } from '../src/index';

/**
 * Helper: create a buffered WS client.
 */
function createBufferedClient(url: string): Promise<{
  ws: WsClient;
  nextMessage: () => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    const buffer: string[] = [];
    const waiting: Array<(msg: string) => void> = [];

    ws.on('message', (data: unknown) => {
      const str = Buffer.isBuffer(data) ? data.toString() : String(data);
      if (waiting.length > 0) {
        waiting.shift()!(str);
      } else {
        buffer.push(str);
      }
    });
    ws.on('error', () => {});

    const timeout = setTimeout(() => reject(new Error(`connect timeout: ${url}`)), 4_000);

    ws.once('open', () => {
      clearTimeout(timeout);
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

    ws.once('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
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

async function expectNoMessage(
  nextMessage: () => Promise<string>,
  ms = 300,
): Promise<void> {
  const result = await Promise.race([
    nextMessage().then(() => 'received' as const),
    new Promise<'nothing'>(r => setTimeout(() => r('nothing'), ms)),
  ]);
  expect(result).toBe('nothing');
}

const ALREADY_SENT = new Response(null, { headers: { 'x-hono-already-sent': 'true' } });

describe('runtime-node publish fan-out', () => {
  let server: RuntimeServerInstance | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop(true);
      server = null;
    }
  });

  // ---------------------------------------------------------------------------
  // Fan-out to multiple subscribers
  // ---------------------------------------------------------------------------

  test('publish fan-out delivers to all subscribers on the same channel', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('news');
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

    const clients = await Promise.all([
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
    ]);

    try {
      for (const c of clients) {
        expect(await c.nextMessage()).toBe('ready');
      }

      server.publish('news', 'fan-out-test');

      for (const c of clients) {
        expect(await c.nextMessage()).toBe('fan-out-test');
      }
    } finally {
      for (const c of clients) {
        await closeWs(c.ws).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 80));
    }
  });

  // ---------------------------------------------------------------------------
  // Disconnected subscriber does not crash fan-out
  // ---------------------------------------------------------------------------

  test('a disconnected subscriber does not prevent other subscribers from receiving', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('fragile');
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

    const clients = await Promise.all([
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
      createBufferedClient(`ws://127.0.0.1:${server.port}/`),
    ]);

    try {
      for (const c of clients) {
        expect(await c.nextMessage()).toBe('ready');
      }

      // Disconnect client 1
      clients[1].ws.terminate();
      await new Promise(r => setTimeout(r, 100));

      // Publish — client 0 should still receive
      server.publish('fragile', 'after-disconnect');
      expect(await clients[0].nextMessage()).toBe('after-disconnect');
    } finally {
      for (const c of clients) {
        await closeWs(c.ws).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 80));
    }
  });

  // ---------------------------------------------------------------------------
  // Channel cleanup when last subscriber unsubscribes
  // ---------------------------------------------------------------------------

  test('channel map is cleaned up when the last subscriber unsubscribes', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('ephemeral');
          ws.send('ready');
        },
        message(ws, msg) {
          if (msg === 'unsub') {
            ws.unsubscribe('ephemeral');
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
      expect(await nextMessage()).toBe('ready');

      // Publish before unsubscribe — should work
      server.publish('ephemeral', 'msg-1');
      expect(await nextMessage()).toBe('msg-1');

      // Send unsubscribe command
      client.send('unsub');
      const ack = await Promise.race([
        nextMessage().then(msg => msg),
        new Promise<string>(r => setTimeout(() => r('timeout'), 500)),
      ]);
      expect(ack).toBe('unsubscribed');

      // Give unsubscribe time to propagate
      await new Promise(r => setTimeout(r, 80));

      // Publishing to the now-empty channel should be a no-op
      server.publish('ephemeral', 'msg-after-unsub');
      await expectNoMessage(nextMessage, 200);
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // Channel isolation
  // ---------------------------------------------------------------------------

  test('publish to different channels are isolated', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          const ch = (ws.data as { ch: string }).ch;
          ws.subscribe(ch);
          ws.send(`sub:${ch}`);
        },
        message() {},
        close() {},
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          const url = new URL(req.url);
          const ch = url.searchParams.get('ch') ?? 'default';
          inst.upgrade(req, { data: { ch } });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    // Connect clients sequentially. Client A connects first to channelA,
    // then client B connects to channelB.
    const chA = await createBufferedClient(`ws://127.0.0.1:${server.port}/?ch=channelB`);
    expect(await chA.nextMessage()).toBe('sub:channelB');

    const chB = await createBufferedClient(`ws://127.0.0.1:${server.port}/?ch=channelA`);
    expect(await chB.nextMessage()).toBe('sub:channelA');

    try {
      // Publish to channelA — only chA receives
      server.publish('channelA', 'message-for-A');
      expect(await chA.nextMessage()).toBe('message-for-A');

      // chB should NOT receive channelA's publish
      await expectNoMessage(chB.nextMessage, 200);

      // Publish to channelB — only chB receives
      server.publish('channelB', 'message-for-B');
      expect(await chB.nextMessage()).toBe('message-for-B');

      // chA should NOT receive channelB's publish
      await expectNoMessage(chA.nextMessage, 200);
    } finally {
      await closeWs(chA.ws);
      await closeWs(chB.ws);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // Multiple publishes in sequence
  // ---------------------------------------------------------------------------

  test('multiple publish calls in sequence all deliver in order', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('ordered');
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

      server.publish('ordered', 'first');
      server.publish('ordered', 'second');
      server.publish('ordered', 'third');

      expect(await nextMessage()).toBe('first');
      expect(await nextMessage()).toBe('second');
      expect(await nextMessage()).toBe('third');
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // ---------------------------------------------------------------------------
  // publish with empty string
  // ---------------------------------------------------------------------------

  test('publish with an empty string message does not throw', async () => {
    const runtime = nodeRuntime();
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('empty');
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

      server.publish('empty', '');
      expect(await nextMessage()).toBe('');
    } finally {
      await closeWs(client);
      await new Promise(r => setTimeout(r, 50));
    }
  });
});
