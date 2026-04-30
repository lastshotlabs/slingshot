/**
 * Multi-instance WebSocket scaling integration tests.
 *
 * Proves that two live Slingshot instances can exchange room messages and
 * presence events through a shared Redis transport.
 *
 * Requires Docker Redis. Run with: bun test tests/docker/ws-scaling.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRedisTransport } from '../../src/framework/ws/redisTransport';
import { authPlugin } from '../setup';
import { createTestFullServer } from '../setup-e2e';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const WS_ENDPOINT = '/ws/scaling';

/**
 * Create a test server with a WS endpoint backed by a Redis transport.
 * Each call produces a fresh transport and server with its own instanceId.
 */
function createWsServerConfig() {
  const transport = createRedisTransport({ connection: REDIS_URL });
  return {
    transport,
    config: {
      plugins: [authPlugin()],
      ws: {
        transport,
        endpoints: {
          [WS_ENDPOINT]: {
            presence: true,
          },
        },
      },
    },
  };
}

async function registerAndGetToken(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password1!' }),
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { token: string };
  expect(typeof body.token).toBe('string');
  return body.token;
}

describe('WS scaling — two-instance fanout (docker)', () => {
  let serverA: Awaited<ReturnType<typeof createTestFullServer>>;
  let serverB: Awaited<ReturnType<typeof createTestFullServer>>;

  beforeAll(async () => {
    const configA = createWsServerConfig();
    const configB = createWsServerConfig();

    serverA = await createTestFullServer(configA.config);
    serverB = await createTestFullServer(configB.config);

    // Allow transport subscriptions to settle
    await new Promise(r => setTimeout(r, 200));
  });

  afterAll(async () => {
    await serverA?.cleanup();
    await serverB?.cleanup();
  });

  test('message published from instance A is received by client on instance B', async () => {
    const room = `scaling-room-${Date.now()}`;

    // Connect a WS client to instance B
    const receivedOnB: string[] = [];
    const wsB = new WebSocket(`${serverB.wsUrl}${WS_ENDPOINT}`);

    await new Promise<void>((resolve, reject) => {
      wsB.onopen = () => resolve();
      wsB.onerror = e => reject(e);
    });

    // Wait for connected event
    await new Promise<void>(resolve => {
      wsB.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'connected') resolve();
      };
    });

    // Subscribe to room on B
    wsB.send(JSON.stringify({ action: 'subscribe', room }));
    await new Promise<void>(resolve => {
      wsB.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'subscribed' && data.room === room) resolve();
      };
    });

    // Set up message listener on B
    wsB.onmessage = event => {
      receivedOnB.push(event.data as string);
    };

    // Connect a WS client to instance A
    const wsA = new WebSocket(`${serverA.wsUrl}${WS_ENDPOINT}`);
    await new Promise<void>((resolve, reject) => {
      wsA.onopen = () => resolve();
      wsA.onerror = e => reject(e);
    });

    // Wait for connected event
    await new Promise<void>(resolve => {
      wsA.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'connected') resolve();
      };
    });

    // Subscribe to the same room on A
    wsA.send(JSON.stringify({ action: 'subscribe', room }));
    await new Promise<void>(resolve => {
      wsA.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'subscribed' && data.room === room) resolve();
      };
    });

    // Publish a message from instance A's context
    // We use the server.publish path via ws.ts publish() which fans out through transport
    const { getServerContext } = await import('../../src/server');
    const ctxA = getServerContext(serverA.server);
    expect(ctxA).not.toBeNull();
    expect(ctxA!.ws).not.toBeNull();

    const { publish } = await import('../../src/framework/ws/rooms');
    publish(ctxA!.ws!, WS_ENDPOINT, room, { text: 'cross-instance-hello' });

    // Wait for transport delivery
    await new Promise(r => setTimeout(r, 500));

    const crossInstanceMsg = receivedOnB.find(raw => {
      try {
        const parsed = JSON.parse(raw);
        return parsed.text === 'cross-instance-hello';
      } catch {
        return false;
      }
    });

    expect(crossInstanceMsg).toBeDefined();

    wsA.close();
    wsB.close();
  });

  test('self-echo is filtered by the server, not by the transport', async () => {
    const room = `echo-room-${Date.now()}`;

    // Connect client to instance A
    const receivedOnA: string[] = [];
    const wsA = new WebSocket(`${serverA.wsUrl}${WS_ENDPOINT}`);

    await new Promise<void>((resolve, reject) => {
      wsA.onopen = () => resolve();
      wsA.onerror = e => reject(e);
    });

    await new Promise<void>(resolve => {
      wsA.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'connected') resolve();
      };
    });

    wsA.send(JSON.stringify({ action: 'subscribe', room }));
    await new Promise<void>(resolve => {
      wsA.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'subscribed' && data.room === room) resolve();
      };
    });

    wsA.onmessage = event => {
      receivedOnA.push(event.data as string);
    };

    // Publish from instance A — the local publish delivers once via server.publish(),
    // and the transport re-delivers from Redis. The server.ts connect handler filters
    // the transport echo by comparing origin === localInstanceId.
    const { getServerContext } = await import('../../src/server');
    const ctxA = getServerContext(serverA.server);

    const { publish } = await import('../../src/framework/ws/rooms');
    publish(ctxA!.ws!, WS_ENDPOINT, room, { text: 'echo-test' });

    // Wait for transport roundtrip
    await new Promise(r => setTimeout(r, 500));

    // The client should receive exactly ONE copy — the local server.publish().
    // The transport's Redis echo should be filtered by origin === localId in server.ts.
    const echoMessages = receivedOnA.filter(raw => {
      try {
        return JSON.parse(raw).text === 'echo-test';
      } catch {
        return false;
      }
    });

    expect(echoMessages).toHaveLength(1);

    wsA.close();
  });

  test('presence join on instance B broadcasts to subscribers on instance A via transport', async () => {
    const room = `presence-test-${Date.now()}`;
    const tokenA = await registerAndGetToken(
      serverA.baseUrl,
      `presence-a-${Date.now()}@example.com`,
    );
    const tokenB = await registerAndGetToken(
      serverB.baseUrl,
      `presence-b-${Date.now()}@example.com`,
    );

    // Connect authenticated client to instance A and subscribe to the presence-enabled room
    const receivedOnA: string[] = [];
    const wsA = new WebSocket(`${serverA.wsUrl}${WS_ENDPOINT}`, {
      // @ts-expect-error Bun accepts header init here; DOM WebSocket typings only expose protocols.
      headers: { 'x-user-token': tokenA },
    });

    await new Promise<void>((resolve, reject) => {
      wsA.onopen = () => resolve();
      wsA.onerror = e => reject(e);
    });

    await new Promise<void>(resolve => {
      wsA.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'connected') resolve();
      };
    });

    wsA.send(JSON.stringify({ action: 'subscribe', room }));
    await new Promise<void>(resolve => {
      wsA.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'subscribed' && data.room === room) resolve();
      };
    });

    wsA.onmessage = event => {
      receivedOnA.push(event.data as string);
    };

    // Allow the initial subscription to settle across the transport
    await new Promise(r => setTimeout(r, 200));

    // Connect a second authenticated client to instance B and subscribe to the same room.
    // Instance B will emit a presence_join that should fan out through the
    // Redis transport and reach instance A's subscriber.
    const wsB = new WebSocket(`${serverB.wsUrl}${WS_ENDPOINT}`, {
      // @ts-expect-error Bun accepts header init here; DOM WebSocket typings only expose protocols.
      headers: { 'x-user-token': tokenB },
    });
    await new Promise<void>((resolve, reject) => {
      wsB.onopen = () => resolve();
      wsB.onerror = e => reject(e);
    });

    await new Promise<void>(resolve => {
      wsB.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'connected') resolve();
      };
    });

    wsB.send(JSON.stringify({ action: 'subscribe', room }));
    await new Promise<void>(resolve => {
      wsB.onmessage = event => {
        const data = JSON.parse(event.data as string);
        if (data.event === 'subscribed' && data.room === room) resolve();
      };
    });

    // Wait for transport delivery of the presence_join broadcast
    await new Promise(r => setTimeout(r, 500));

    const joinMsg = receivedOnA.find(raw => {
      try {
        const parsed = JSON.parse(raw);
        return parsed.event === 'presence_join' && parsed.room === room;
      } catch {
        return false;
      }
    });

    expect(joinMsg).toBeDefined();

    wsA.close();
    wsB.close();
  });

  test('shutdown disconnects transport cleanly on both instances', async () => {
    const configC = createWsServerConfig();
    const serverC = await createTestFullServer(configC.config);

    // Server should be running
    expect(serverC.server.port).toBeGreaterThan(0);

    // Cleanup should not throw
    await expect(serverC.cleanup()).resolves.toBeUndefined();
  });
});
