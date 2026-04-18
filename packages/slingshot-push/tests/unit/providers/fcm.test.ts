/**
 * Unit tests for createFcmProvider.
 *
 * Covers: happy path, silent data-only message, platform mismatch,
 * all classified HTTP failure codes, and FCM OAuth token caching.
 *
 * fetch is mocked via spyOn — no real HTTP requests made.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createFcmProvider } from '../../../src/providers/fcm';
import type { FirebaseServiceAccount } from '../../../src/types/config';
import type { PushSubscriptionRecord } from '../../../src/types/models';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SERVICE_ACCOUNT: FirebaseServiceAccount = {
  project_id: 'test-project',
  client_email: 'firebase@test.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbM/teOhm4JqsJ\nomb1XBVnGDnj/xW/HSxI7A2vHHzpOZyCKugSs9saBsFbj6p3gMroHFP87C/TCWxr\nIn2dyUJtV8VRGG6GamkMWN/3ecITJh+JuFm1Y7X5TfEyPTr/s53ubrZZP0L6x8lg\nb482ebq6e7+6VuPpUdlayC4/X739SwtXfgIvy9ycYvRFayzW2iEysu81baDlaEBD\n1KPLAi/YREs4td0Cp/Kf86/JlNFqhfWtWfo4nIO8xmu/anF3CsIobr0JTsR2DK/n\n6Mk1YzrJSP+/wsY+MtgFARhYQpjqpuXunj4DUNIPdjwHebeiFRKNiyc/Ge4z5x8B\nreo7J0J3AgMBAAECggEAN8iEwbf7b5e3kx4XIX2rnK7XnKP/vsEH0g7wdI3FY/zb\nTWzp3kiTC46IimqHMR4/hM4guY7JpOUTCDigyxS6qOTbPAYBqodN8Gx1op8DuqfL\nAts9SSH031rsdKKMbyIgoNrf4Npuiy9omfgJ9A0KbgasBhmyql+/9pBW5J3S1bBY\ncmPN+N8LsNZGpIuozU9A5mIVORVd7GPry5mTenc0bx1TJK+phywguCQVOjpbZwtV\naJS2hHoy5BAAsBvvq33n/i0k9vtaKoEi9IOqoXMmFGMHsVAK0sXag5OFqzT8YWuu\nu44g1nwidCSydrpTommKLQZhg2nwSVErpgDEPBwN4QKBgQD+nLuwJzV+Lde7LNv2\nDvFgYUCKsov6qvi5s4oARQZbywNuRPd9CS/eEFSlYMH2UUW8Krr7jOB+34SOxcNJ\ngJ1PsWF68LF8I6vh1KE1rknp/88avTkhyfh4nH5vLb7KqffOhLyHSqTKu6KS60pj\nPUmOEDE98eE3CVBlyHdK0Cj4DwKBgQDcZddnujpDS6uOpEwVw7Pa+rjaaJ/oNFQz\nWH19m/wHh4BAuV9L4mtXgv3ZaK0xllaopHMb4M1fqxTJDLz8kBVJgtp+uZiBq4In\nC/ayfGtCPiWAX3fN2siNIMQXnD69LX77y8x2xAQHUrwTB+lMpW3oKTohJYFarmtM\n1mrOvhdnGQKBgAXmvhbsIbpF970X4hVG7WNNfcB5OPNbaR5sweMVtnsELpUstgvI\n3boo6L1Yi8ZYxeQBnYndDwsBxUHF5avbdkn1k4vU7lgxP3ehhQcIfiAVVMiK4Dsf\nQkoRXoDXL5fk7qBzxSbhnQYx6Se8mmHIdt77ExkbdRvgdGOXjORIBNsTAoGACPV6\n1BSV2bZxutKi5R+XaAdZDEfEeEPoSE4Ii9qTXBr986OVZBhIFL6WYwgGQkXCMAi/\nRRrWPlVN+v4xkHKq6toO16fjsyGtoLizxn2YPpEYJSe8TvndvR7f2bXYNwhqaQHX\nxdwh7cpHKt7fdOYkmZNTcZV8tJrycaUlolHH0cECgYEA8qDiev8RnGOhIgVTXUkc\nDunfd11mXKORKiQOn/eCL9FsV/V7TzXzhl6TSu7iJwa7Sqh3f/OT/gDY18ZYJVvz\n3tVO5gLGfIod/HN7W832pIz5ZteKKbo35tkvx/vDo7oJlnF8Cot4PwCD1pJYR7OW\nPrRQkZIf2M+5+/kQwYDsseE=\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token',
};

function androidSub(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    id: 'sub-android',
    userId: 'user-1',
    tenantId: '',
    deviceId: 'device-1',
    platform: 'android',
    platformData: {
      platform: 'android',
      registrationToken: 'fcm-reg-token-123',
      packageName: 'com.example.app',
    },
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

function makeJsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTokenResponse(): Response {
  return makeJsonResponse(200, {
    access_token: 'fake-access-token',
    expires_in: 3600,
    token_type: 'Bearer',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function setupFetch(messageResponse: Response): void {
  let callCount = 0;
  fetchSpy.mockImplementation(async () => {
    callCount += 1;
    if (callCount === 1) return makeTokenResponse(); // OAuth token exchange
    return messageResponse; // FCM send
  });
}

describe('createFcmProvider — happy path', () => {
  test('returns { ok: true } on 200 response', async () => {
    setupFetch(makeJsonResponse(200, { name: 'projects/test/messages/abc123' }));
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerMessageId).toBe('projects/test/messages/abc123');
  });

  test('platform is "android"', () => {
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    expect(provider.platform).toBe('android');
  });

  test('calls the FCM HTTP v1 endpoint with project ID in URL', async () => {
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      urls.push(url.toString());
      return urls.length === 1 ? makeTokenResponse() : makeJsonResponse(200, { name: 'x' });
    });
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    await provider.send(androidSub(), { title: 'Hello' });
    const fcmCall = urls.find(u => u.includes('fcm.googleapis.com'));
    expect(fcmCall).toBeDefined();
    expect(fcmCall).toContain('test-project');
  });
});

describe('createFcmProvider — silent push', () => {
  test('omits notification block for silent message', async () => {
    let sentBody: Record<string, unknown> | undefined;
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (!sentBody && init?.body) {
        const parsed = JSON.parse(init.body as string) as { message?: unknown };
        if (parsed.message) {
          sentBody = parsed as Record<string, unknown>;
        } else {
          return makeTokenResponse();
        }
      }
      return makeJsonResponse(200, { name: 'x' });
    });
    // Reset and use a cleaner mock
    fetchSpy.mockReset();
    setupFetch(makeJsonResponse(200, { name: 'x' }));
    // Re-mock to capture FCM body
    fetchSpy.mockReset();
    let callCount = 0;
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) return makeTokenResponse();
      sentBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      return makeJsonResponse(200, { name: 'x' });
    });

    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    await provider.send(androidSub(), { title: 'Silent', silent: true });

    const msg = (sentBody as { message: Record<string, unknown> }).message;
    expect(msg['notification']).toBeUndefined();
    expect(msg['data']).toBeDefined();
  });
});

describe('createFcmProvider — platform mismatch', () => {
  test('returns transient error when platformData.platform !== "android"', async () => {
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const iosSub = androidSub({
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
    // fetch not called — short-circuited before OAuth
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createFcmProvider — HTTP error classification', () => {
  test('404 → invalidToken', async () => {
    setupFetch(makeJsonResponse(404, { error: { status: 'NOT_FOUND' } }));
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidToken');
  });

  test('410 → invalidToken', async () => {
    setupFetch(makeJsonResponse(410, {}));
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalidToken');
  });

  test('413 → payloadTooLarge', async () => {
    setupFetch(makeJsonResponse(413, {}));
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('payloadTooLarge');
  });

  test('429 → rateLimited', async () => {
    setupFetch(makeJsonResponse(429, {}));
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rateLimited');
  });

  test('500 → transient', async () => {
    setupFetch(makeJsonResponse(500, { error: { status: 'INTERNAL' } }));
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('transient');
  });
});

describe('createFcmProvider — OAuth token caching', () => {
  test('calls token endpoint only once on repeated sends', async () => {
    let tokenCallCount = 0;
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      if (url.toString().includes('oauth2')) {
        tokenCallCount += 1;
        return makeTokenResponse();
      }
      return makeJsonResponse(200, { name: `msg-${tokenCallCount}` });
    });

    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    await provider.send(androidSub(), { title: 'First' });
    await provider.send(androidSub({ id: 'sub-2', deviceId: 'd2' }), { title: 'Second' });

    // Token should only be fetched once since it's cached
    expect(tokenCallCount).toBe(1);
  });
});
