import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createFcmProvider } from '../../src/providers/fcm';
import type { FirebaseServiceAccount } from '../../src/types/config';
import type { PushSubscriptionRecord } from '../../src/types/models';

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

describe('createFcmProvider getHealth()', () => {
  test('reports a closed circuit and zero failures on a fresh provider', () => {
    const provider = createFcmProvider({ serviceAccount: TEST_SERVICE_ACCOUNT });
    const health = provider.getHealth?.();
    expect(health).toBeDefined();
    expect(health?.circuitState).toBe('closed');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.circuitThreshold).toBe(5);
    expect(health?.lastFailureAt).toBeNull();
  });

  test('opens the circuit and tracks lastFailureAt after threshold consecutive token failures', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('network unreachable');
    });

    const provider = createFcmProvider({
      serviceAccount: TEST_SERVICE_ACCOUNT,
      tokenFailureCircuitThreshold: 2,
    });

    await provider.send(androidSub(), { title: 'Hello' });
    let health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.circuitState).toBe('closed');
    expect(health?.lastFailureAt).not.toBeNull();

    await provider.send(androidSub(), { title: 'Hello' });
    health = provider.getHealth?.();
    expect(health?.consecutiveFailures).toBe(2);
    expect(health?.circuitState).toBe('open');
  });
});
