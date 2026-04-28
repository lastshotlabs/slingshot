/**
 * Unit tests covering CRLF / NUL injection rejection in push provider
 * outbound headers. The providers should never emit a forged header
 * line and should surface a transient failure to the router instead.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ApnsTokenAuth, createApnsProvider } from '../../../src/providers/apns';
import { createWebPushProvider } from '../../../src/providers/web';
import type { PushSubscriptionRecord } from '../../../src/types/models';

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

function iosSub(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
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
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('apns provider — header injection', () => {
  test('rejects CRLF in bundleId without contacting Apple', async () => {
    const provider = createApnsProvider({ auth: fakeAuth, defaultEnvironment: 'sandbox' });
    const sub = iosSub({
      platformData: {
        platform: 'ios',
        deviceToken: 'aabbccdd',
        bundleId: 'com.example.app\r\nX-Injected: yes',
        environment: 'sandbox',
      },
    });
    const result = await provider.send(sub, { title: 't', body: 'b' });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe('transient');
    expect(result.ok ? '' : (result.error ?? '')).toContain('apns-topic');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('web push provider — header injection', () => {
  test('rejects CRLF in idempotencyKey without contacting the push service', async () => {
    // Mock the web-push module so a successful return shouldn't even be reached.
    const sendNotification = mock(async () => ({}) as never);
    mock.module('web-push', () => ({
      default: { sendNotification },
      sendNotification,
    }));

    const provider = createWebPushProvider({
      vapid: {
        publicKey:
          'BNbW5fS5oPQ6ksI4mnhXz6E_kVndJyDqROpQpPjMV9z9_owmYjjVzJk4l-Sru0DBM5dqrMNJD3oIPL36BUHPLGM',
        privateKey: 'Vt5NZJlj3hP6m6F5pDfVpvA6LpNX7vHrm1rFfKyBuI8',
        subject: 'mailto:test@example.com',
      },
    });

    const result = await provider.send(
      {
        id: 'sub-web',
        userId: 'user-1',
        tenantId: '',
        deviceId: 'device-1',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example.com/sub',
          keys: { p256dh: 'p256dh', auth: 'auth' },
        },
        createdAt: new Date(),
        lastSeenAt: new Date(),
      },
      { title: 't', body: 'b' },
      { idempotencyKey: 'key-1\r\nX-Injected: yes' },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe('transient');
    expect(result.ok ? '' : (result.error ?? '')).toContain('X-Idempotency-Key');
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
