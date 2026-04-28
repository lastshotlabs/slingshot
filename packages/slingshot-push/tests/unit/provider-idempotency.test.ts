/**
 * Verify the deterministic provider-idempotency keying:
 *   - The same `(deliveryId, attempt)` pair produces the same UUID v4 string.
 *   - Different attempts on the same delivery produce different UUIDs.
 *   - Format: lowercase 8-4-4-4-12 hex with version 4 and RFC 4122 variant bits.
 *   - APNs provider sends the derived UUID as the `apns-id` request header.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { buildProviderIdempotencyKey, deriveUuidV4FromKey } from '../../src/lib/idempotency';
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

let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Provider idempotency keys', () => {
  test('buildProviderIdempotencyKey is deterministic per (deliveryId, attempt)', () => {
    expect(buildProviderIdempotencyKey('d-1', 1)).toBe('d-1:1');
    expect(buildProviderIdempotencyKey('d-1', 2)).toBe('d-1:2');
    expect(buildProviderIdempotencyKey('abc', 7)).toBe('abc:7');
  });

  test('deriveUuidV4FromKey is stable for the same key', () => {
    const key = buildProviderIdempotencyKey('delivery-XYZ', 1);
    const a = deriveUuidV4FromKey(key);
    const b = deriveUuidV4FromKey(key);
    expect(a).toBe(b);
    expect(a).toMatch(UUID_V4_RE);
  });

  test('different attempts produce different UUIDs for the same delivery', () => {
    const a = deriveUuidV4FromKey(buildProviderIdempotencyKey('delivery-XYZ', 1));
    const b = deriveUuidV4FromKey(buildProviderIdempotencyKey('delivery-XYZ', 2));
    expect(a).not.toBe(b);
    expect(a).toMatch(UUID_V4_RE);
    expect(b).toMatch(UUID_V4_RE);
  });

  test('different deliveries produce different UUIDs for the same attempt', () => {
    const a = deriveUuidV4FromKey(buildProviderIdempotencyKey('delivery-A', 1));
    const b = deriveUuidV4FromKey(buildProviderIdempotencyKey('delivery-B', 1));
    expect(a).not.toBe(b);
  });

  test('APNs provider sends derived UUID as apns-id header when context.idempotencyKey present', async () => {
    let observedHeaders: Record<string, string> = {};
    fetchSpy.mockImplementation(async (_url: unknown, init: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init.headers as HeadersInit));
      return new Response('', { status: 200, headers: { 'apns-id': 'srv-msg-1' } });
    });
    const provider = createApnsProvider({
      auth: fakeAuth,
      defaultBundleId: 'com.example.app',
      defaultEnvironment: 'sandbox',
    });
    const key = buildProviderIdempotencyKey('delivery-1', 1);
    await provider.send(iosSub(), { title: 'Hi' }, { idempotencyKey: key });
    expect(observedHeaders['apns-id']).toBe(deriveUuidV4FromKey(key));
    expect(observedHeaders['apns-id']).toMatch(UUID_V4_RE);
  });

  test('APNs provider omits apns-id header when no idempotencyKey is given', async () => {
    let observedHeaders: Record<string, string> = {};
    fetchSpy.mockImplementation(async (_url: unknown, init: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init.headers as HeadersInit));
      return new Response('', { status: 200 });
    });
    const provider = createApnsProvider({
      auth: fakeAuth,
      defaultBundleId: 'com.example.app',
      defaultEnvironment: 'sandbox',
    });
    await provider.send(iosSub(), { title: 'Hi' });
    expect(observedHeaders['apns-id']).toBeUndefined();
  });
});
