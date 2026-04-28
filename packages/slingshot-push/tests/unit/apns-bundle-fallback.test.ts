/**
 * Verify APNs provider falls back to `defaultBundleId` when the subscription's
 * `platformData.bundleId` is the empty string. Empty-string is treated as
 * "not configured", which `??` would not have caught.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ApnsTokenAuth, createApnsProvider } from '../../src/providers/apns';
import type { PushSubscriptionRecord } from '../../src/types/models';

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

function iosSub(bundleId: string): PushSubscriptionRecord {
  return {
    id: 'sub-ios',
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-1',
    platform: 'ios',
    platformData: {
      platform: 'ios',
      deviceToken: 'aabbccdd',
      bundleId,
      environment: 'sandbox',
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
}

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('APNs bundle-id empty-string coercion', () => {
  test('empty bundleId on subscription falls back to defaultBundleId', async () => {
    let observedHeaders: Record<string, string> = {};
    fetchSpy.mockImplementation(async (_url: unknown, init: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init.headers as HeadersInit));
      return new Response('', { status: 200 });
    });

    const provider = createApnsProvider({
      auth: fakeAuth,
      defaultBundleId: 'com.example.fallback',
      defaultEnvironment: 'sandbox',
    });

    const result = await provider.send(iosSub(''), { title: 'Hi' });
    expect(result.ok).toBe(true);
    expect(observedHeaders['apns-topic']).toBe('com.example.fallback');
  });

  test('still errors when both subscription bundleId and defaultBundleId are missing/empty', async () => {
    const provider = createApnsProvider({
      auth: fakeAuth,
      defaultBundleId: '',
      defaultEnvironment: 'sandbox',
    });
    const result = await provider.send(iosSub(''), { title: 'Hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('transient');
  });

  test('non-empty subscription bundleId wins over default', async () => {
    let observedHeaders: Record<string, string> = {};
    fetchSpy.mockImplementation(async (_url: unknown, init: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init.headers as HeadersInit));
      return new Response('', { status: 200 });
    });

    const provider = createApnsProvider({
      auth: fakeAuth,
      defaultBundleId: 'com.example.fallback',
      defaultEnvironment: 'sandbox',
    });
    const result = await provider.send(iosSub('com.example.specific'), { title: 'Hi' });
    expect(result.ok).toBe(true);
    expect(observedHeaders['apns-topic']).toBe('com.example.specific');
  });
});
