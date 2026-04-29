import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createWebPushProvider } from '../../src/providers/web.js';

const stubModule = mock();

let mockSendNotification: ReturnType<typeof mock>;

mock.module('web-push', () => {
  const sendNotification = mock(() => Promise.resolve());
  mockSendNotification = sendNotification;
  return {
    default: { sendNotification },
    sendNotification,
  };
});
stubModule;

describe('web push provider timeout (P-PUSH-7)', () => {
  beforeEach(() => {
    if (mockSendNotification) mockSendNotification.mockReset();
  });

  afterEach(() => {
    if (mockSendNotification) mockSendNotification.mockReset();
  });

  test('webpush.sendNotification that hangs indefinitely is aborted by providerTimeoutMs', async () => {
    mockSendNotification.mockImplementation(() => new Promise(() => {}));

    const provider = createWebPushProvider({
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:x@example.com' },
      providerTimeoutMs: 30,
    });

    const result = await provider.send(
      {
        id: 'sub-1',
        userId: 'u',
        tenantId: '',
        deviceId: 'd',
        platform: 'web',
        platformData: {
          platform: 'web',
          endpoint: 'https://push.example/1',
          keys: { auth: 'a', p256dh: 'p' },
        },
        createdAt: new Date(),
        lastSeenAt: new Date(),
      } as never,
      { title: 'x' },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('transient');
    // The timeout error message should include the configured timeout
    expect(result.error).toMatch(/Timed out after 30ms/);
  });
});
