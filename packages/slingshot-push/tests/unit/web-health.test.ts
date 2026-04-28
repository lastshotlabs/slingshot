import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PushSubscriptionRecord } from '../../src/types/models';

// ---------------------------------------------------------------------------
// Mock web-push BEFORE importing the provider
// ---------------------------------------------------------------------------

const mockSendNotification = mock(() => Promise.resolve());

mock.module('web-push', () => ({
  default: {
    sendNotification: mockSendNotification,
  },
  sendNotification: mockSendNotification,
}));

// Must be a dynamic import so the mock is applied first
const { createWebPushProvider } = await import('../../src/providers/web');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_VAPID = {
  publicKey:
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  privateKey: 'UUxI4O8-HoKnVjo17uBj55NfTvLvT3TJ-U80bKGF9Y0',
  subject: 'mailto:test@example.com',
} as const;

function webSub(): PushSubscriptionRecord {
  return {
    id: 'sub-1',
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-1',
    platform: 'web',
    platformData: {
      platform: 'web',
      endpoint: 'https://example.com/push',
      keys: { p256dh: 'p256key', auth: 'authkey' },
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
}

function mockHttpError(statusCode: number): void {
  mockSendNotification.mockImplementation(() => {
    const err = new Error(`HTTP ${statusCode}`) as Error & { statusCode: number };
    err.statusCode = statusCode;
    throw err;
  });
}

beforeEach(() => {
  mockSendNotification.mockReset();
  mockSendNotification.mockImplementation(() => Promise.resolve());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWebPushProvider getHealth()', () => {
  test('reports a closed circuit and zero failures on a fresh provider', () => {
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const health = provider.getHealth?.();
    expect(health).toBeDefined();
    expect(health?.circuitState).toBe('closed');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.circuitThreshold).toBe(5);
    expect(health?.lastFailureAt).toBeNull();
  });

  test('uses configured failureCircuitThreshold', () => {
    const provider = createWebPushProvider({ vapid: TEST_VAPID, failureCircuitThreshold: 3 });
    const health = provider.getHealth?.();
    expect(health?.circuitThreshold).toBe(3);
  });
});

describe('createWebPushProvider — circuit breaker', () => {
  test('trips after threshold consecutive transient failures', async () => {
    mockHttpError(500);
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 2,
      circuitCooldownMs: 60_000,
    });

    const r1 = await provider.send(webSub(), { title: 'Hello' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('transient');
    let health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.circuitState).toBe('closed');
    expect(health?.lastFailureAt).not.toBeNull();

    const r2 = await provider.send(webSub(), { title: 'Hello' });
    expect(r2.ok).toBe(false);
    health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(2);
    expect(health?.circuitState).toBe('open');
  });

  test('open breaker short-circuits send and returns transient with retryAfterMs', async () => {
    mockHttpError(500);
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });

    // Trip the breaker.
    await provider.send(webSub(), { title: 'Hello' });
    expect(provider.getHealth?.().circuitState).toBe('open');

    // Next send should short-circuit — web-push must NOT be called a second time.
    const callsBefore = mockSendNotification.mock.calls.length;
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(mockSendNotification.mock.calls.length).toBe(callsBefore);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transient');
      expect(typeof result.retryAfterMs).toBe('number');
      expect(result.retryAfterMs!).toBeGreaterThanOrEqual(0);
      expect(result.error).toMatch(/circuit breaker open/i);
    }
  });

  test('half-open probe is admitted after cooldown elapses', async () => {
    mockHttpError(500);
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 1,
      circuitCooldownMs: 50,
    });

    await provider.send(webSub(), { title: 'Hello' });
    expect(provider.getHealth?.().circuitState).toBe('open');

    // Wait for cooldown to elapse.
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(provider.getHealth?.().circuitState).toBe('half-open');

    // Next send is the probe — it should be admitted (web-push called).
    const callsBefore = mockSendNotification.mock.calls.length;
    await provider.send(webSub(), { title: 'Hello' });
    expect(mockSendNotification.mock.calls.length).toBe(callsBefore + 1);
  });

  test('successful send resets the counter', async () => {
    // First call fails, second succeeds.
    let callIdx = 0;
    mockSendNotification.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        const err = Object.assign(new Error('boom'), { statusCode: 500 });
        throw err;
      }
      return Promise.resolve();
    });

    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 5,
    });

    await provider.send(webSub(), { title: 'Hello' });
    expect(provider.getHealth?.().consecutiveFailures).toBe(1);

    const ok = await provider.send(webSub(), { title: 'Hello' });
    expect(ok.ok).toBe(true);
    const health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.circuitState).toBe('closed');
    expect(health?.lastFailureAt).toBeNull();
  });

  test('invalidToken does not increment the counter', async () => {
    mockHttpError(410);
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 2,
    });

    const r1 = await provider.send(webSub(), { title: 'Hello' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('invalidToken');
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);

    const r2 = await provider.send(webSub(), { title: 'Hello' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('invalidToken');
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);
    expect(provider.getHealth?.().circuitState).toBe('closed');
  });

  test('payloadTooLarge does not increment the counter', async () => {
    mockHttpError(413);
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 2,
    });

    await provider.send(webSub(), { title: 'Hello' });
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);
  });

  test('silent push rejection does not increment the counter', async () => {
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 2,
    });

    // Silent push is rejected before web-push is ever called — must not affect breaker.
    const r = await provider.send(webSub(), { title: 'Silent', silent: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('payloadTooLarge');
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);
  });

  test('rateLimited (429) increments the counter', async () => {
    mockHttpError(429);
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 5,
    });

    await provider.send(webSub(), { title: 'Hello' });
    expect(provider.getHealth?.().consecutiveFailures).toBe(1);
  });

  test('network error (no statusCode) increments the counter', async () => {
    mockSendNotification.mockImplementation(() => {
      throw new Error('network unreachable');
    });
    const provider = createWebPushProvider({
      vapid: TEST_VAPID,
      failureCircuitThreshold: 5,
    });

    const r = await provider.send(webSub(), { title: 'Hello' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('transient');
    expect(provider.getHealth?.().consecutiveFailures).toBe(1);
  });
});
