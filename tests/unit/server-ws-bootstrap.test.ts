import { afterEach, describe, expect, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createServer, getServerContext } from '../../src/server';

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

const baseConfig = {
  meta: { name: 'Server WS Bootstrap Test' },
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

let server: Awaited<ReturnType<typeof createServer>> | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      try {
        await Promise.race([
          new Promise(resolve => {
            socket.addEventListener('close', () => resolve(undefined), { once: true });
            socket.close();
          }),
          new Promise(resolve => setTimeout(resolve, 250)),
        ]);
      } catch {
        /* best-effort */
      }
    }
  }

  if (server) {
    const ctx = getServerContext(server);
    await server.stop(true);
    await ctx?.destroy();
    server = null;
  }
});

describe('createServer websocket bootstrap', () => {
  test('serves plugin-registered incoming handlers from the bootstrap ws endpoint draft', async () => {
    const plugin: SlingshotPlugin = {
      name: 'ws-bootstrap-plugin',
      setupPost({ app }) {
        const endpointMap = getContext(app).wsEndpoints as Record<
          string,
          Record<string, unknown>
        > | null;
        if (!endpointMap) {
          throw new Error('Expected ws endpoint draft on SlingshotContext.');
        }

        const endpoint = (endpointMap['/chat'] ??= {});
        endpoint.incoming = {
          ...(endpoint.incoming as Record<string, unknown> | undefined),
          ping: {
            handler: (_ws: unknown, payload: unknown) => ({ echoed: payload }),
          },
        };
      },
    };

    server = await createServer({
      ...baseConfig,
      hostname: '127.0.0.1',
      port: 0,
      plugins: [plugin],
      ws: {
        endpoints: {
          '/chat': {},
        },
      },
    });

    const ctx = getServerContext(server);
    expect(ctx?.wsEndpoints && '/chat' in ctx.wsEndpoints).toBeTrue();

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat`);
    sockets.push(ws);

    await withTimeout(waitForOpen(ws), 2_000, 'websocket open');
    await withTimeout(waitForMessage(ws), 2_000, 'connected event');

    ws.send(
      JSON.stringify({
        action: 'event',
        event: 'ping',
        payload: { text: 'hello' },
        ackId: 'ack-1',
      }),
    );

    const ack = await withTimeout(waitForMessage(ws), 2_000, 'plugin event ack');
    expect(ack).toEqual({
      event: 'ack',
      ackId: 'ack-1',
      result: { echoed: { text: 'hello' } },
    });
  });
});
