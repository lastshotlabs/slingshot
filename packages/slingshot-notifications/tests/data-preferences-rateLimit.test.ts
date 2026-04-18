import { describe, expect, test } from 'bun:test';
import {
  NotificationDataTooLargeError,
  freezeNotificationData,
  isWithinQuietHours,
  resolveEffectivePriority,
  resolvePreferences,
} from '../src';
import {
  createInMemoryRateLimitBackend,
  createNoopRateLimitBackend,
  registerRateLimitBackend,
  resolveRateLimitBackend,
} from '../src/rateLimit';

describe('notification data helpers', () => {
  test('freezes notification data deeply', () => {
    const frozen = freezeNotificationData({
      title: 'Mention',
      meta: { count: 2 },
    });

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.meta as object)).toBe(true);
  });

  test('rejects data payloads larger than the byte limit', () => {
    const oversized = { body: 'x'.repeat(8 * 1024 + 32) };

    expect(() => freezeNotificationData(oversized)).toThrow(NotificationDataTooLargeError);
  });
});

describe('notification preferences', () => {
  test('applies precedence from defaults to global to source to type preferences', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [
            {
              userId: 'user-1',
              scope: 'global',
              muted: false,
              pushEnabled: false,
              emailEnabled: true,
              inAppEnabled: true,
            },
            {
              userId: 'user-1',
              scope: 'source',
              source: 'community',
              muted: false,
              pushEnabled: true,
              emailEnabled: false,
              inAppEnabled: true,
            },
            {
              userId: 'user-1',
              scope: 'type',
              type: 'community:mention',
              muted: true,
              pushEnabled: true,
              emailEnabled: false,
              inAppEnabled: false,
              quietStart: '22:00',
              quietEnd: '06:00',
            },
          ];
        },
      },
      'user-1',
      'community',
      'community:mention',
      {
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
      },
    );

    expect(prefs).toEqual({
      muted: true,
      pushEnabled: true,
      emailEnabled: false,
      inAppEnabled: false,
      quietStart: '22:00',
      quietEnd: '06:00',
    });
    expect(Object.isFrozen(prefs)).toBe(true);
  });

  test('evaluates quiet hours for normal, overnight, invalid, and full-day windows', () => {
    expect(
      isWithinQuietHours(
        {
          muted: false,
          pushEnabled: true,
          emailEnabled: true,
          inAppEnabled: true,
          quietStart: '09:00',
          quietEnd: '17:00',
        },
        new Date('2026-04-15T12:30:00Z'),
      ),
    ).toBe(true);

    expect(
      isWithinQuietHours(
        {
          muted: false,
          pushEnabled: true,
          emailEnabled: true,
          inAppEnabled: true,
          quietStart: '22:00',
          quietEnd: '06:00',
        },
        new Date('2026-04-15T23:15:00Z'),
      ),
    ).toBe(true);

    expect(
      isWithinQuietHours(
        {
          muted: false,
          pushEnabled: true,
          emailEnabled: true,
          inAppEnabled: true,
          quietStart: '25:00',
          quietEnd: '06:00',
        },
        new Date('2026-04-15T23:15:00Z'),
      ),
    ).toBe(false);

    expect(
      isWithinQuietHours(
        {
          muted: false,
          pushEnabled: true,
          emailEnabled: true,
          inAppEnabled: true,
          quietStart: '00:00',
          quietEnd: '00:00',
        },
        new Date('2026-04-15T12:00:00Z'),
      ),
    ).toBe(true);
  });

  test('downgrades non-urgent priorities during quiet hours only', () => {
    const prefs = {
      muted: false,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
      quietStart: '22:00',
      quietEnd: '06:00',
    };

    expect(resolveEffectivePriority('high', prefs, new Date('2026-04-15T23:30:00Z'))).toBe('low');
    expect(resolveEffectivePriority('urgent', prefs, new Date('2026-04-15T23:30:00Z'))).toBe(
      'urgent',
    );
    expect(resolveEffectivePriority('normal', prefs, new Date('2026-04-15T12:00:00Z'))).toBe(
      'normal',
    );
  });
});

describe('notification rate-limit backends', () => {
  test('enforces and clears the in-memory fixed window backend', async () => {
    const backend = createInMemoryRateLimitBackend();

    await expect(backend.check('user-1', 2, 60_000)).resolves.toBe(true);
    await expect(backend.check('user-1', 2, 60_000)).resolves.toBe(true);
    await expect(backend.check('user-1', 2, 60_000)).resolves.toBe(false);

    backend.clear?.();

    await expect(backend.check('user-1', 2, 60_000)).resolves.toBe(true);
  });

  test('returns the noop backend and supports custom registry entries', async () => {
    await expect(createNoopRateLimitBackend().check('user-1', 1, 1)).resolves.toBe(true);

    const customName = `custom-${Date.now()}`;
    registerRateLimitBackend(customName, () => ({
      async check() {
        return false;
      },
    }));

    await expect(resolveRateLimitBackend(customName).check('user-1', 1, 1)).resolves.toBe(false);
  });

  test('throws for unknown backend names with the known registry list', () => {
    expect(() => resolveRateLimitBackend('missing-backend')).toThrow(/Unknown rate-limit backend/);
  });
});
