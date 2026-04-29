/**
 * Real WebSocket handshake integration tests for runtime-node.
 *
 * Connects real `ws` library clients to a server started by the Node runtime,
 * and verifies the upgrade handshake, bidirectional message exchange, and
 * lifecycle callback ordering.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket as WsClient } from 'ws';
import type { RuntimeServerInstance } from '@lastshotlabs/slingshot-core';
import { nodeRuntime } from '../../src/index';

const ALREADY_SENT = new Response(null, { headers: { 'x-hono-already-sent': 'true' } });

/**
 * Create a WsClient with a buffered message queue.
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

describe('runtime-node WebSocket handshake integration', () => {
  let server: RuntimeServerInstance | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop(true);
      server = null;
    }
  });

  test('upgrade handshake completes and open handler fires with data payload', async () => {
    const runtime = nodeRuntime();
    let openFired = false;
    let receivedData: unknown;
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          openFired = true;
          receivedData = ws.data;
          ws.send('ack');
        },
        message() {},
        close() {},
      },
      fetch(req) {
        if (req.headers.get('upgrade') === 'websocket') {
          inst.upgrade(req, { data: { userId: 'alice' } });
          return ALREADY_SENT;
        }
        return new Response('ok');
      },
    });
    inst = server;

    const { ws: client, nextMessage } = await createBufferedClient(
      `ws://127.0.0.1:${server.port}/`,
    );

    expect(await nextMessage()).toBe('ack');
    expect(openFired).toBe(true);
    expect(receivedData).toEqual({ userId: 'alice' });

    await closeWs(client);
  });

  test('bidirectional message exchange over WebSocket', async () => {
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

    expect(await nextMessage()).toBe('ready');

    client.send('hello');
    expect(await nextMessage()).toBe('echo:hello');

    client.send('world');
    expect(await nextMessage()).toBe('echo:world');

    await closeWs(client);
  });

  test('close handler fires when client disconnects', async () => {
    const runtime = nodeRuntime();
    let closeFired = false;
    let inst: RuntimeServerInstance;

    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open(ws) {
          ws.send('ready');
        },
        message() {},
        close() {
          closeFired = true;
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
    await new Promise(r => setTimeout(r, 80));

    expect(closeFired).toBe(true);
  });

  test('full lifecycle fires in order: open -> message -> close', async () => {
    const events: string[] = [];
    let inst: RuntimeServerInstance;

    const runtime = nodeRuntime();
    server = await runtime.server.listen({
      port: 0,
      websocket: {
        open() {
          events.push('open');
        },
        message() {
          events.push('message');
        },
        close() {
          events.push('close');
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
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual(['open']);

    client.send('hi');
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual(['open', 'message']);

    await closeWs(client);
    await new Promise(r => setTimeout(r, 80));
    expect(events).toEqual(['open', 'message', 'close']);
  });
});
