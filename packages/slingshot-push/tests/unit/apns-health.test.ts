import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ApnsTokenAuth, createApnsProvider } from '../../src/providers/apns';
import type { PushSubscriptionRecord } from '../../src/types/models';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal fake auth — returns a stable token without crypto operations. */
const fakeAuth: ApnsTokenAuth = Object.assign(
  new ApnsTokenAuth({
    kind: 'p8-token',
    keyPem:
      '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEICmawIWQEsLmB4WN+62zJDn44lJCs3Iyq4hIlKRcPVeJoAoGCCqGSM49\nAwEHoUQDQgAE+MkY0hyzZYelSR/lcg9bEsd6zlWZsmymYTPgpi9kiON4k+MYzXbU\nIcRQnD+cVqUhWwrB7CAk1414ISQSEI/2Bw==\n-----END EC PRIVATE KEY-----',
    keyId: 'KEYID12345',
    teamId: 'TEAMID1234',
  }),
  { getToken: () => 'fake-apns-token' },
);

function iosSub(): PushSubscriptionRecord {
  return {
    id: 'sub-ios',
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-1',
    platform: 'ios',
    platformData: {
      platform: 'ios',
      deviceToken: 'aabbccdd',
      bundleId: 'com.example.app',
      environment: 'sandbox',
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
}

function makeFetchResponse(
  status: number,
  body: string = '',
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  });
}

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('createApnsProvider getHealth()', () => {
  test('reports a closed circuit and zero failures on a fresh provider', () => {
    const provider = createApnsProvider({ auth: fakeAuth });
    const health = provider.getHealth?.();
    expect(health).toBeDefined();
    expect(health?.circuitState).toBe('closed');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.circuitThreshold).toBe(5);
    expect(health?.lastFailureAt).toBeNull();
  });

  test('uses configured failureCircuitThreshold', () => {
    const provider = createApnsProvider({ auth: fakeAuth, failureCircuitThreshold: 3 });
    const health = provider.getHealth?.();
    expect(health?.circuitThreshold).toBe(3);
  });
});

describe('createApnsProvider — circuit breaker', () => {
  test('trips after threshold consecutive transient failures', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(500, 'server error'));
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 2,
      circuitCooldownMs: 60_000,
    });

    const r1 = await provider.send(iosSub(), { title: 'Hello' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('transient');
    let health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.circuitState).toBe('closed');
    expect(health?.lastFailureAt).not.toBeNull();

    const r2 = await provider.send(iosSub(), { title: 'Hello' });
    expect(r2.ok).toBe(false);
    health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(2);
    expect(health?.circuitState).toBe('open');
  });

  test('open breaker short-circuits send and returns transient with retryAfterMs', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(500, 'server error'));
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });

    // Trip the breaker.
    await provider.send(iosSub(), { title: 'Hello' });
    expect(provider.getHealth?.().circuitState).toBe('open');

    // Next send should short-circuit — fetch must NOT be called a second time.
    const callsBefore = fetchSpy.mock.calls.length;
    const result = await provider.send(iosSub(), { title: 'Hello' });
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transient');
      expect(typeof result.retryAfterMs).toBe('number');
      expect(result.retryAfterMs!).toBeGreaterThanOrEqual(0);
      expect(result.error).toMatch(/circuit breaker open/i);
    }
  });

  test('half-open probe is admitted after cooldown elapses', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(500, 'server error'));
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 1,
      circuitCooldownMs: 50,
    });

    await provider.send(iosSub(), { title: 'Hello' });
    expect(provider.getHealth?.().circuitState).toBe('open');

    // Wait for cooldown to elapse.
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(provider.getHealth?.().circuitState).toBe('half-open');

    // Next send is the probe — it should be admitted (fetch called).
    const callsBefore = fetchSpy.mock.calls.length;
    await provider.send(iosSub(), { title: 'Hello' });
    expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1);
  });

  test('successful send resets the counter', async () => {
    // First call fails, second succeeds.
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse(500, 'server error'))
      .mockResolvedValueOnce(makeFetchResponse(200, '', { 'apns-id': 'apns-1' }));

    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 5,
    });

    await provider.send(iosSub(), { title: 'Hello' });
    expect(provider.getHealth?.().consecutiveFailures).toBe(1);

    const ok = await provider.send(iosSub(), { title: 'Hello' });
    expect(ok.ok).toBe(true);
    const health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.circuitState).toBe('closed');
    expect(health?.lastFailureAt).toBeNull();
  });

  test('invalidToken does not increment the counter', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(410, 'BadDeviceToken'));
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 2,
    });

    const r1 = await provider.send(iosSub(), { title: 'Hello' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('invalidToken');
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);

    const r2 = await provider.send(iosSub(), { title: 'Hello' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('invalidToken');
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);
    expect(provider.getHealth?.().circuitState).toBe('closed');
  });

  test('payloadTooLarge does not increment the counter', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(413, 'PayloadTooLarge'));
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 2,
    });

    await provider.send(iosSub(), { title: 'Hello' });
    expect(provider.getHealth?.().consecutiveFailures).toBe(0);
  });

  test('rateLimited (429) increments the counter', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse(429, 'TooManyRequests'));
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 5,
    });

    await provider.send(iosSub(), { title: 'Hello' });
    expect(provider.getHealth?.().consecutiveFailures).toBe(1);
  });

  test('network error increments the counter', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('network unreachable');
    });
    const provider = createApnsProvider({
      auth: fakeAuth,
      failureCircuitThreshold: 5,
    });

    const r = await provider.send(iosSub(), { title: 'Hello' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('transient');
    expect(provider.getHealth?.().consecutiveFailures).toBe(1);
  });
});
