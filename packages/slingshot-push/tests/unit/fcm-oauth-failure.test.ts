/**
 * Verify FCM provider classifies a failure to acquire an OAuth access token
 * as a `transient` outcome with `retryAfterMs: 30_000` and emits a structured
 * `code: 'fcm-oauth-failure'` log line, rather than letting the error
 * propagate as an unrecoverable repository failure.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createFcmProvider } from '../../src/providers/fcm';
import { type PushRouterRepos, createPushRouter } from '../../src/router';
import type { FirebaseServiceAccount } from '../../src/types/config';
import type {
  PushDeliveryRecord,
  PushSubscriptionRecord,
  PushTopicMembershipRecord,
} from '../../src/types/models';

const TEST_SERVICE_ACCOUNT: FirebaseServiceAccount = {
  project_id: 'test-project',
  client_email: 'firebase@test.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbM/teOhm4JqsJ\nomb1XBVnGDnj/xW/HSxI7A2vHHzpOZyCKugSs9saBsFbj6p3gMroHFP87C/TCWxr\nIn2dyUJtV8VRGG6GamkMWN/3ecITJh+JuFm1Y7X5TfEyPTr/s53ubrZZP0L6x8lg\nb482ebq6e7+6VuPpUdlayC4/X739SwtXfgIvy9ycYvRFayzW2iEysu81baDlaEBD\n1KPLAi/YREs4td0Cp/Kf86/JlNFqhfWtWfo4nIO8xmu/anF3CsIobr0JTsR2DK/n\n6Mk1YzrJSP+/wsY+MtgFARhYQpjqpuXunj4DUNIPdjwHebeiFRKNiyc/Ge4z5x8B\nreo7J0J3AgMBAAECggEAN8iEwbf7b5e3kx4XIX2rnK7XnKP/vsEH0g7wdI3FY/zb\nTWzp3kiTC46IimqHMR4/hM4guY7JpOUTCDigyxS6qOTbPAYBqodN8Gx1op8DuqfL\nAts9SSH031rsdKKMbyIgoNrf4Npuiy9omfgJ9A0KbgasBhmyql+/9pBW5J3S1bBY\ncmPN+N8LsNZGpIuozU9A5mIVORVd7GPry5mTenc0bx1TJK+phywguCQVOjpbZwtV\naJS2hHoy5BAAsBvvq33n/i0k9vtaKoEi9IOqoXMmFGMHsVAK0sXag5OFqzT8YWuu\nu44g1nwidCSydrpTommKLQZhg2nwSVErpgDEPBwN4QKBgQD+nLuwJzV+Lde7LNv2\nDvFgYUCKsov6qvi5s4oARQZbywNuRPd9CS/eEFSlYMH2UUW8Krr7jOB+34SOxcNJ\ngJ1PsWF68LF8I6vh1KE1rknp/88avTkhyfh4nH5vLb7KqffOhLyHSqTKu6KS60pj\nPUmOEDE98eE3CVBlyHdK0Cj4DwKBgQDcZddnujpDS6uOpEwVw7Pa+rjaaJ/oNFQz\nWH19m/wHh4BAuV9L4mtXgv3ZaK0xllaopHMb4M1fqxTJDLz8kBVJgtp+uZiBq4In\nC/ayfGtCPiWAX3fN2siNIMQXnD69LX77y8x2xAQHUrwTB+lMpW3oKTohJYFarmtM\n1mrOvhdnGQKBgAXmvhbsIbpF970X4hVG7WNNfcB5OPNbaR5sweMVtnsELpUstgvI\n3boo6L1Yi8ZYxeQBnYndDwsBxUHF5avbdkn1k4vU7lgxP3ehhQcIfiAVVMiK4Dsf\nQkoRXoDXL5fk7qBzxSbhnQYx6Se8mmHIdt77ExkbdRvgdGOXjORIBNsTAoGACPV6\n1BSV2bZxutKi5R+XaAdZDEfEeEPoSE4Ii9qTXBr986OVZBhIFL6WYwgGQkXCMAi/\nRRrWPlVN+v4xkHKq6toO16fjsyGtoLizxn2YPpEYJSe8TvndvR7f2bXYNwhqaQHX\nxdwh7cpHKt7fdOYkmZNTcZV8tJrycaUlolHH0cECgYEA8qDiev8RnGOhIgVTXUkc\nDunfd11mXKORKiQOn/eCL9FsV/V7TzXzhl6TSu7iJwa7Sqh3f/OT/gDY18ZYJVvz\n3tVO5gLGfIod/HN7W832pIz5ZteKKbo35tkvx/vDo7oJlnF8Cot4PwCD1pJYR7OW\nPrRQkZIf2M+5+/kQwYDsseE=\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token',
};

function androidSub(): PushSubscriptionRecord {
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
  };
}

let fetchSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('FCM OAuth token failure', () => {
  test('OAuth token endpoint failure produces transient outcome with retryAfterMs: 30_000', async () => {
    fetchSpy.mockImplementation(async () => {
      // Token endpoint returns malformed payload — getToken() throws.
      return new Response('not-json-token-error', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transient');
      expect(result.retryAfterMs).toBe(30_000);
    }
  });

  test('OAuth network error is also classified transient', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('network unreachable');
    });

    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const result = await provider.send(androidSub(), { title: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('transient');
      expect(result.retryAfterMs).toBe(30_000);
      expect(result.error).toContain('fcm oauth failure');
    }
  });

  test('emits a structured log with code "fcm-oauth-failure"', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('network unreachable');
    });
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    await provider.send(androidSub(), { title: 'Hello' });

    const logged = errorSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('fcm-oauth-failure'),
    );
    expect(logged).toBeDefined();
    const parsed = JSON.parse(String(logged?.[0])) as Record<string, unknown>;
    expect(parsed['code']).toBe('fcm-oauth-failure');
    expect(parsed['project']).toBe('test-project');
  });

  test('router maps OAuth failure to retryable transient outcome (not repositoryFailure)', async () => {
    // Force token endpoint to throw on every call so retries also see transient.
    fetchSpy.mockImplementation(async () => {
      throw new Error('network unreachable');
    });

    const deliveries: PushDeliveryRecord[] = [];
    const subscriptions: PushSubscriptionRecord[] = [androidSub()];
    const memberships: PushTopicMembershipRecord[] = [];
    const repos: PushRouterRepos = {
      subscriptions: {
        create: async () => subscriptions[0]!,
        getById: async (id: string) => subscriptions.find(s => s.id === id) ?? null,
        delete: async () => true,
        listByUserId: async () => ({ items: subscriptions }),
        findByDevice: async () => null,
        touchLastSeen: async () => subscriptions[0]!,
        upsertByDevice: async () => subscriptions[0]!,
      },
      topics: {
        ensureByName: async () => ({ id: 't', name: 'n', tenantId: '' }),
        findByName: async () => null,
      },
      topicMemberships: {
        ensureMembership: async () => memberships[0]!,
        listByTopic: async () => ({ items: memberships }),
        removeByTopicAndSub: async () => ({ count: 0 }),
        removeBySubscription: async () => ({ count: 0 }),
      },
      deliveries: {
        create: async input => {
          const delivery: PushDeliveryRecord = {
            id: `d-${deliveries.length + 1}`,
            tenantId: '',
            userId: (input as Record<string, unknown>)['userId'] as string,
            subscriptionId: (input as Record<string, unknown>)['subscriptionId'] as string,
            platform: 'android',
            notificationId: null,
            providerMessageId: null,
            status: 'pending',
            failureReason: null,
            attempts: 0,
            sentAt: null,
            deliveredAt: null,
            createdAt: new Date(),
          };
          deliveries.push(delivery);
          return delivery;
        },
        getById: async (id: string) => deliveries.find(d => d.id === id) ?? null,
        markSent: async () => null,
        markDelivered: async () => null,
        markFailed: async ({ id, failureReason }) => {
          const d = deliveries.find(x => x.id === id);
          if (!d) return null;
          Object.assign(d, { status: 'failed', failureReason });
          return d;
        },
        incrementAttempts: async (id: string) => {
          const d = deliveries.find(x => x.id === id);
          if (d) Object.assign(d, { attempts: d.attempts + 1 });
          return d ?? {};
        },
      },
    };

    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const router = createPushRouter({
      providers: { android: provider },
      repos,
      retries: { maxAttempts: 1, initialDelayMs: 0 },
    });
    await router.sendToUser('user-1', { title: 'Hi' });

    expect(deliveries[0]!.status).toBe('failed');
    // Critical: it's transient, not repositoryFailure.
    expect(deliveries[0]!.failureReason).toBe('transient');
  });
});
