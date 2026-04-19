import { afterEach, describe, expect, test } from 'bun:test';
import { publish } from '../../src/framework/ws/rooms';
import { getServerContext } from '../../src/server';
import { type E2EServerHandle, createTestFullServer } from '../setup-e2e';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
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
    ws.addEventListener('error', e => reject(e), { once: true });
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise<any>(resolve => {
    ws.addEventListener('message', e => resolve(JSON.parse(e.data as string)), { once: true });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => {
    ws.addEventListener('close', e => resolve({ code: e.code, reason: e.reason }), { once: true });
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let handle: E2EServerHandle | null = null;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  // Close any open sockets
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  openSockets.length = 0;

  if (handle) {
    handle.stop();
    handle = null;
  }

  // Brief pause to let Bun clean up between tests
  await new Promise(r => setTimeout(r, 50));
});

// ---------------------------------------------------------------------------
// 1. Basic connection and upgrade
// ---------------------------------------------------------------------------

describe('WebSocket E2E — basic connection', () => {
  test('client connects and receives connected event', async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {},
        },
      },
    });

    const ws = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(ws);

    await withTimeout(waitForOpen(ws), 2000, 'open');
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Default upgrade handler sends { event: "connected", id: <uuid> } on open
    const connected = await withTimeout(waitForMessage(ws), 2000, 'connected event');
    expect(connected.event).toBe('connected');
    expect(typeof connected.id).toBe('string');

    ws.close();
  });

  test('upgrade returns 400 for non-WS request', async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {},
        },
      },
    });

    // A plain HTTP GET to the upgrade path should get a 400
    const res = await fetch(`${handle.baseUrl}/chat`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Upgrade failed');
  });
});

// ---------------------------------------------------------------------------
// 2. Room subscribe / receive
// ---------------------------------------------------------------------------

describe('WebSocket E2E — room pub/sub', () => {
  test('client subscribes to a room and receives subscribed event', async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {},
        },
      },
    });

    const ws = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(ws);

    await withTimeout(waitForOpen(ws), 2000, 'open');

    // Drain the initial "connected" message
    await withTimeout(waitForMessage(ws), 2000, 'connected event');

    ws.send(JSON.stringify({ action: 'subscribe', room: 'general' }));
    const subscribed = await withTimeout(waitForMessage(ws), 2000, 'subscribed event');
    expect(subscribed.event).toBe('subscribed');
    expect(subscribed.room).toBe('general');

    ws.close();
  });

  test('two clients: subscriber receives message published by server to room', async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {
            on: {
              // Echo all non-room-action messages to the room as a broadcast
              message: async (_socket, message) => {
                const raw = typeof message === 'string' ? message : Buffer.from(message).toString();
                try {
                  const data = JSON.parse(raw);
                  if (data.action === 'publish' && data.room && data.payload !== undefined) {
                    publish(getServerContext(handle!.server)!.ws!, '/chat', data.room, {
                      event: 'message',
                      room: data.room,
                      payload: data.payload,
                    });
                  }
                } catch {
                  /* ignore */
                }
              },
            },
          },
        },
      },
    });

    const subscriber = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(subscriber);
    await withTimeout(waitForOpen(subscriber), 2000, 'subscriber open');
    // Drain connected event
    await withTimeout(waitForMessage(subscriber), 2000, 'subscriber connected');

    // Subscribe to room
    subscriber.send(JSON.stringify({ action: 'subscribe', room: 'lobby' }));
    const sub = await withTimeout(waitForMessage(subscriber), 2000, 'subscribed');
    expect(sub.event).toBe('subscribed');

    // Start collecting messages for subscriber
    const messagePromise = withTimeout(waitForMessage(subscriber), 2000, 'room message');

    // Publisher connects and publishes
    const publisher = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(publisher);
    await withTimeout(waitForOpen(publisher), 2000, 'publisher open');
    // Drain connected event
    await withTimeout(waitForMessage(publisher), 2000, 'publisher connected');

    publisher.send(
      JSON.stringify({ action: 'publish', room: 'lobby', payload: { text: 'hello' } }),
    );

    const msg = await messagePromise;
    expect(msg.event).toBe('message');
    expect(msg.room).toBe('lobby');
    expect(msg.payload.text).toBe('hello');

    subscriber.close();
    publisher.close();
  });

  test('client can unsubscribe from a room', async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {},
        },
      },
    });

    const ws = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(ws);
    await withTimeout(waitForOpen(ws), 2000, 'open');
    await withTimeout(waitForMessage(ws), 2000, 'connected');

    ws.send(JSON.stringify({ action: 'subscribe', room: 'temp' }));
    const subscribed = await withTimeout(waitForMessage(ws), 2000, 'subscribed');
    expect(subscribed.event).toBe('subscribed');

    ws.send(JSON.stringify({ action: 'unsubscribe', room: 'temp' }));
    const unsubscribed = await withTimeout(waitForMessage(ws), 2000, 'unsubscribed');
    expect(unsubscribed.event).toBe('unsubscribed');
    expect(unsubscribed.room).toBe('temp');

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Heartbeat
// ---------------------------------------------------------------------------

describe('WebSocket E2E — heartbeat', () => {
  test('connection stays alive after receiving a ping frame', async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {
            heartbeat: { intervalMs: 300, timeoutMs: 600 },
          },
        },
      },
    });

    const ws = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(ws);
    await withTimeout(waitForOpen(ws), 2000, 'open');
    await withTimeout(waitForMessage(ws), 2000, 'connected');

    // Wait long enough for at least one heartbeat ping to be sent and pong to be replied
    // Bun's WebSocket auto-responds to ping with pong — we just need to verify
    // the connection is still alive after one heartbeat cycle
    await new Promise(r => setTimeout(r, 500));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Server error handler shape
// ---------------------------------------------------------------------------

describe('WebSocket E2E — server error handler', () => {
  test("createServer error handler returns { error: 'Internal Server Error' } on 500", async () => {
    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {
            // Custom upgrade that always throws — triggers the Bun error() handler
            upgrade: async () => {
              throw new Error('forced error for testing');
            },
          },
        },
      },
    });

    // Attempting to upgrade to a path where upgrade() throws
    // Bun's error() handler returns { error: "Internal Server Error" } with 500
    const res = await fetch(`${handle.baseUrl}/chat`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal Server Error');
  });
});

// ---------------------------------------------------------------------------
// 5. on.close hook fires on disconnect
// ---------------------------------------------------------------------------

describe('WebSocket E2E — lifecycle hooks', () => {
  test('on.close hook fires when client disconnects', async () => {
    const closeFired: string[] = [];

    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {
            on: {
              close: async () => {
                closeFired.push('closed');
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(ws);
    await withTimeout(waitForOpen(ws), 2000, 'open');
    await withTimeout(waitForMessage(ws), 2000, 'connected');

    const closePromise = waitForClose(ws);
    ws.close(1000, 'done');
    await withTimeout(closePromise, 2000, 'close event');

    // Give server time to run the close hook
    await new Promise(r => setTimeout(r, 200));

    expect(closeFired).toHaveLength(1);
    expect(closeFired[0]).toBe('closed');
  });

  test('on.open hook fires when client connects', async () => {
    const openFired: string[] = [];

    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {
            on: {
              open: async () => {
                openFired.push('opened');
              },
            },
          },
        },
      },
    });

    const ws = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(ws);
    await withTimeout(waitForOpen(ws), 2000, 'open');
    await withTimeout(waitForMessage(ws), 2000, 'connected');

    // Give server time to run the open hook
    await new Promise(r => setTimeout(r, 100));

    expect(openFired).toHaveLength(1);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple endpoints
// ---------------------------------------------------------------------------

describe('WebSocket E2E — multiple endpoints', () => {
  test("endpoints are independent — subscriber on /chat doesn't receive /notifications traffic", async () => {
    const chatMessages: any[] = [];

    handle = await createTestFullServer({
      ws: {
        endpoints: {
          '/chat': {
            on: {
              message: async (_ws, message) => {
                const raw = typeof message === 'string' ? message : Buffer.from(message).toString();
                try {
                  const data = JSON.parse(raw);
                  if (data.action === 'publish' && data.room && data.payload !== undefined) {
                    publish(getServerContext(handle!.server)!.ws!, '/chat', data.room, {
                      event: 'message',
                      room: data.room,
                      payload: data.payload,
                    });
                  }
                } catch {
                  /* ignore */
                }
              },
            },
          },
          '/notifications': {
            on: {
              message: async (_ws, message) => {
                const raw = typeof message === 'string' ? message : Buffer.from(message).toString();
                try {
                  const data = JSON.parse(raw);
                  if (data.action === 'publish' && data.room && data.payload !== undefined) {
                    publish(getServerContext(handle!.server)!.ws!, '/notifications', data.room, {
                      event: 'message',
                      room: data.room,
                      payload: data.payload,
                    });
                  }
                } catch {
                  /* ignore */
                }
              },
            },
          },
        },
      },
    });

    // Connect subscriber to /chat and subscribe to "room-a"
    const chatWs = new WebSocket(`${handle.wsUrl}/chat`);
    openSockets.push(chatWs);
    await withTimeout(waitForOpen(chatWs), 2000, 'chat open');
    await withTimeout(waitForMessage(chatWs), 2000, 'chat connected');
    chatWs.send(JSON.stringify({ action: 'subscribe', room: 'room-a' }));
    await withTimeout(waitForMessage(chatWs), 2000, 'chat subscribed');

    // Collect messages on chatWs
    chatWs.addEventListener('message', e => {
      chatMessages.push(JSON.parse(e.data as string));
    });

    // Connect publisher to /notifications and publish to "room-a" on that endpoint
    const notifPublisher = new WebSocket(`${handle.wsUrl}/notifications`);
    openSockets.push(notifPublisher);
    await withTimeout(waitForOpen(notifPublisher), 2000, 'notif open');
    await withTimeout(waitForMessage(notifPublisher), 2000, 'notif connected');

    notifPublisher.send(
      JSON.stringify({ action: 'publish', room: 'room-a', payload: { text: 'notif only' } }),
    );

    // Wait briefly — chatWs should NOT receive this
    await new Promise(r => setTimeout(r, 200));

    // chatMessages should only have subscription-related events (none of the notif publish)
    const roomMessages = chatMessages.filter(m => m.event === 'message');
    expect(roomMessages).toHaveLength(0);

    chatWs.close();
    notifPublisher.close();
  });
});
