/**
 * Real WebSocket integration tests for runtime-bun.
 *
 * Uses the built-in Bun WebSocket client to connect to a real server started
 * by the runtime, and verifies the wrapped lifecycle callbacks fire correctly:
 * open, message, close, and pong.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeServerInstance, RuntimeWebSocket } from '@lastshotlabs/slingshot-core';
import { bunRuntime } from '../src/index';

/**
 * Open a WebSocket client and resolve once `open` fires.
 */
function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`connect failed: ${url}`)), { once: true });
    // Hard timeout in case neither fires.
    setTimeout(() => reject(new Error(`connect timeout: ${url}`)), 4_000);
  });
}

describe('runtime-bun WebSocket integration — lifecycle callbacks', () => {
  let server: RuntimeServerInstance | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop(true).catch(() => {});
      server = undefined;
    }
  });

  test('open fires when client connects; data payload is accessible', async () => {
    let opened = false;
    let receivedData: unknown;

    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          server?.upgrade?.(req, { data: { clientId: 'test-1' } });
          return new Response(null, { status: 101 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws: RuntimeWebSocket) {
          opened = true;
          receivedData = ws.data;
        },
        message() {},
        close() {},
      },
    });

    const ws = await openClient(`ws://127.0.0.1:${server.port}/ws`);
    // Give the open handler a moment to fire
    await new Promise(r => setTimeout(r, 50));
    expect(opened).toBe(true);
    expect(receivedData).toEqual({ clientId: 'test-1' });
    ws.close();
  });

  test('message handler fires with correct text payload', async () => {
    const messages: string[] = [];

    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          server?.upgrade?.(req, { data: {} });
          return new Response(null, { status: 101 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(_ws: RuntimeWebSocket, msg: string | Buffer) {
          messages.push(typeof msg === 'string' ? msg : msg.toString());
        },
        close() {},
      },
    });

    const ws = await openClient(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise(r => setTimeout(r, 30));
    ws.send('hello');
    ws.send('world');
    await new Promise(r => setTimeout(r, 50));
    expect(messages).toEqual(['hello', 'world']);
    ws.close();
  });

  test('handler echoes message back to client', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          server?.upgrade?.(req, { data: {} });
          return new Response(null, { status: 101 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws: RuntimeWebSocket) {
          ws.send('ready');
        },
        message(ws: RuntimeWebSocket, msg: string | Buffer) {
          const text = typeof msg === 'string' ? msg : msg.toString();
          ws.send(`echo:${text}`);
        },
        close() {},
      },
    });

    const ws = await openClient(`ws://127.0.0.1:${server.port}/ws`);
    const received: string[] = [];
    ws.addEventListener('message', (ev: MessageEvent) => received.push(String(ev.data)));

    await new Promise(r => setTimeout(r, 30));
    expect(received).toContain('ready');

    ws.send('ping');
    await new Promise(r => setTimeout(r, 30));
    expect(received).toContain('echo:ping');

    ws.close();
  });

  test('close handler fires when client disconnects', async () => {
    let closeFired = false;
    let closeCode = 0;

    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          server?.upgrade?.(req, { data: {} });
          return new Response(null, { status: 101 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws: RuntimeWebSocket) {
          ws.send('ready');
        },
        message() {},
        close(_ws: RuntimeWebSocket, code: number) {
          closeFired = true;
          closeCode = code;
        },
      },
    });

    const ws = await openClient(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise(r => setTimeout(r, 30));
    ws.close(1000);
    await new Promise(r => setTimeout(r, 100));
    expect(closeFired).toBe(true);
    expect(closeCode).toBe(1000);
  });

  test('pong handler fires when client responds to server ping', async () => {
    let pongCount = 0;
    let serverWs: RuntimeWebSocket | undefined;

    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          server?.upgrade?.(req, { data: {} });
          return new Response(null, { status: 101 });
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws: RuntimeWebSocket) {
          serverWs = ws;
        },
        message() {},
        close() {},
        pong() {
          pongCount += 1;
        },
      },
    });

    const ws = await openClient(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise(r => setTimeout(r, 30));
    expect(serverWs).toBeDefined();

    serverWs!.ping();
    // The browser-spec WebSocket client auto-replies with a pong frame.
    await new Promise(r => setTimeout(r, 100));
    expect(pongCount).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  test('full lifecycle fires in order: open -> message -> close', async () => {
    const events: string[] = [];

    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname === '/ws') {
          server?.upgrade?.(req, { data: {} });
          return new Response(null, { status: 101 });
        }
        return new Response('not found', { status: 404 });
      },
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
    });

    const ws = await openClient(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual(['open']);

    ws.send('hi');
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual(['open', 'message']);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
    expect(events).toEqual(['open', 'message', 'close']);
  });
});
