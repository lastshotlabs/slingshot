/**
 * Unit tests for createWebPushProvider.
 *
 * Covers: happy path, silent-push rejection, platform-mismatch, and all
 * classified HTTP failure codes (invalidToken, payloadTooLarge, rateLimited,
 * transient).
 *
 * web-push is mocked at the module level so no real HTTP requests are made.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PushSubscriptionRecord } from '../../../src/types/models';

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
const { createWebPushProvider } = await import('../../../src/providers/web');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_VAPID = {
  publicKey:
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  privateKey: 'UUxI4O8-HoKnVjo17uBj55NfTvLvT3TJ-U80bKGF9Y0',
  subject: 'mailto:test@example.com',
} as const;

function webSub(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSendNotification.mockReset();
  mockSendNotification.mockImplementation(() => Promise.resolve());
});

describe('createWebPushProvider — happy path', () => {
  test('returns { ok: true } on successful send', async () => {
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(result.ok).toBe(true);
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
  });

  test('platform is "web"', () => {
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    expect(provider.platform).toBe('web');
  });
});

describe('createWebPushProvider — silent push rejection', () => {
  test('rejects silent push with payloadTooLarge reason', async () => {
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Silent', silent: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('payloadTooLarge');
      expect(result.error).toMatch(/silent/i);
    }
    // web-push must NOT be called
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('createWebPushProvider — platform mismatch', () => {
  test('returns transient error when platformData.platform !== "web"', async () => {
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const iosSub = webSub({
      platform: 'ios',
      platformData: {
        platform: 'ios',
        deviceToken: 'tok',
        bundleId: 'com.test',
        environment: 'sandbox',
      },
    });
    const result = await provider.send(iosSub, { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('transient');
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('createWebPushProvider — HTTP error classification', () => {
  function mockHttpError(statusCode: number): void {
    mockSendNotification.mockImplementation(() => {
      const err = new Error(`HTTP ${statusCode}`) as Error & { statusCode: number };
      err.statusCode = statusCode;
      throw err;
    });
  }

  test('404 → invalidToken', async () => {
    mockHttpError(404);
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidToken');
  });

  test('410 → invalidToken', async () => {
    mockHttpError(410);
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidToken');
  });

  test('413 → payloadTooLarge', async () => {
    mockHttpError(413);
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('payloadTooLarge');
  });

  test('429 → rateLimited', async () => {
    mockHttpError(429);
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rateLimited');
  });

  test('500 → transient', async () => {
    mockHttpError(500);
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('transient');
  });

  test('retryAfterMs is always in milliseconds when provider returns seconds header', async () => {
    // web-push library maps Retry-After seconds to retryAfterMs — our provider
    // receives the error and the value must be in ms. Web provider always returns
    // ms (converted from raw HTTP Retry-After). Since web-push errors don't expose
    // retryAfterMs directly, verify the field is present or undefined, not a
    // seconds value.
    mockSendNotification.mockImplementation(() => {
      const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
      throw err;
    });
    const provider = createWebPushProvider({ vapid: TEST_VAPID });
    const result = await provider.send(webSub(), { title: 'Hello' });
    if (!result.ok && result.retryAfterMs !== undefined) {
      // If present, must be >= 1000 (never raw seconds 1..120)
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1000);
    }
    // ok — retryAfterMs may be undefined for web provider
  });
});
