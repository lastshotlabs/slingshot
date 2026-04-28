import { describe, expect, mock, test } from 'bun:test';
import type { NotificationCreatedEventPayload } from '@lastshotlabs/slingshot-core';
import { createPushDeliveryAdapter } from '../../src/deliveryAdapter';
import type { CompiledPushFormatterTable } from '../../src/state';
import type { PushMessage } from '../../src/types/models';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<NotificationCreatedEventPayload['notification']> = {},
  pushEnabled = true,
): NotificationCreatedEventPayload {
  return {
    notification: {
      id: 'notif-1',
      userId: 'user-1',
      tenantId: 'tenant-a',
      source: 'test-source',
      type: 'test.event',
      read: false,
      dispatched: false,
      priority: 'normal',
      createdAt: new Date().toISOString(),
      targetId: null,
      ...overrides,
    },
    preferences: {
      muted: false,
      pushEnabled,
      emailEnabled: false,
      inAppEnabled: true,
    },
  };
}

const STUB_MESSAGE: PushMessage = {
  title: 'Hello',
  body: 'World',
};

function makeFormatters(message: PushMessage = STUB_MESSAGE): CompiledPushFormatterTable {
  return {
    templates: {},
    resolve: () => null,
    register: () => {},
    format: mock(() => message),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPushDeliveryAdapter', () => {
  test('skips delivery when pushEnabled is false', async () => {
    const sendToUser = mock(async () => ({ delivered: 0, attempted: 0, allFailed: false }));
    const adapter = createPushDeliveryAdapter({
      router: {
        sendToUser,
        sendToUsers: mock(async () => ({ delivered: 0, attempted: 0, allFailed: false })),
      } as never,
      formatters: makeFormatters(),
    });

    await adapter.deliver(makeEvent({}, false));

    expect(sendToUser).not.toHaveBeenCalled();
  });

  test('skips delivery when notification source is in skipSources', async () => {
    const sendToUser = mock(async () => ({ delivered: 0, attempted: 0, allFailed: false }));
    const adapter = createPushDeliveryAdapter({
      router: {
        sendToUser,
        sendToUsers: mock(async () => ({ delivered: 0, attempted: 0, allFailed: false })),
      } as never,
      formatters: makeFormatters(),
      skipSources: ['blocked-source'],
    });

    await adapter.deliver(makeEvent({ source: 'blocked-source' }));

    expect(sendToUser).not.toHaveBeenCalled();
  });

  test('delivers to user when pushEnabled and source not skipped', async () => {
    const sendToUser = mock(async () => ({ delivered: 1, attempted: 1, allFailed: false }));
    const adapter = createPushDeliveryAdapter({
      router: {
        sendToUser,
        sendToUsers: mock(async () => ({ delivered: 0, attempted: 0, allFailed: false })),
      } as never,
      formatters: makeFormatters(),
    });

    const event = makeEvent({ id: 'notif-42', userId: 'user-7', tenantId: 'tenant-x' });
    await adapter.deliver(event);

    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [userId, , deliveryOptions] = sendToUser.mock.calls[0] as unknown as [
      string,
      unknown,
      { tenantId: string; notificationId: string },
    ];
    expect(userId).toBe('user-7');
    expect(deliveryOptions).toMatchObject({
      tenantId: 'tenant-x',
      notificationId: 'notif-42',
    });
  });

  test('uses notification.targetId as URL when not null', async () => {
    const formatFn = mock(() => STUB_MESSAGE);
    const formatters = makeFormatters();
    formatters.format = formatFn;

    const adapter = createPushDeliveryAdapter({
      router: {
        sendToUser: mock(async () => ({ delivered: 1, attempted: 1, allFailed: false })),
        sendToUsers: mock(async () => ({ delivered: 0, attempted: 0, allFailed: false })),
      } as never,
      formatters,
      defaults: { defaultUrl: '/fallback', icon: '/icon.png' },
    });

    await adapter.deliver(makeEvent({ targetId: '/items/99' }));

    const formatterArg = (formatFn.mock.calls[0] as unknown as [unknown, { url?: string }])[1];
    expect(formatterArg.url).toBe('/items/99');
  });

  test('falls back to defaults.defaultUrl when targetId is null', async () => {
    const formatFn = mock(() => STUB_MESSAGE);
    const formatters = makeFormatters();
    formatters.format = formatFn;

    const adapter = createPushDeliveryAdapter({
      router: {
        sendToUser: mock(async () => ({ delivered: 1, attempted: 1, allFailed: false })),
        sendToUsers: mock(async () => ({ delivered: 0, attempted: 0, allFailed: false })),
      } as never,
      formatters,
      defaults: { defaultUrl: '/home', icon: '/icon.png' },
    });

    await adapter.deliver(makeEvent({ targetId: null }));

    const formatterArg = (formatFn.mock.calls[0] as unknown as [unknown, { url?: string }])[1];
    expect(formatterArg.url).toBe('/home');
  });

  test('uses empty string tenantId when notification.tenantId is null', async () => {
    const sendToUser = mock(async () => ({ delivered: 1, attempted: 1, allFailed: false }));
    const adapter = createPushDeliveryAdapter({
      router: {
        sendToUser,
        sendToUsers: mock(async () => ({ delivered: 0, attempted: 0, allFailed: false })),
      } as never,
      formatters: makeFormatters(),
    });

    await adapter.deliver(makeEvent({ tenantId: null }));

    const opts = (
      sendToUser.mock.calls[0] as unknown as [unknown, unknown, { tenantId: string }]
    )[2];
    expect(opts.tenantId).toBe('');
  });
});
