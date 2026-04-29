/**
 * Edge-case coverage for notification preference resolution.
 *
 * Builds on the core preference tests in data-preferences-rateLimit.test.ts.
 * Covers quiet hours at exact boundary times, midnight/overnight windows,
 * invalid time formats, empty preference sets, scope merging edge cases,
 * and the fallback chain when no preferences exist at any scope.
 */
import { describe, expect, test } from 'bun:test';
import type { NotificationPreferenceAdapter } from '../../src';
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  isWithinQuietHours,
  resolveEffectivePriority,
  resolvePreferences,
} from '../../src/preferences';

// ---------------------------------------------------------------------------
// Quiet hours: boundary conditions
// ---------------------------------------------------------------------------

describe('quiet hours boundary conditions', () => {
  test('exactly at quietStart time (09:00) is within quiet hours', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '09:00',
        quietEnd: '17:00',
      },
      new Date('2026-04-15T09:00:00Z'),
    );
    expect(result).toBe(true);
  });

  test('one minute before quietEnd (16:59) is within quiet hours', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '09:00',
        quietEnd: '17:00',
      },
      new Date('2026-04-15T16:59:00Z'),
    );
    expect(result).toBe(true);
  });

  test('exactly at quietEnd time (17:00) is OUTSIDE quiet hours', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '09:00',
        quietEnd: '17:00',
      },
      new Date('2026-04-15T17:00:00Z'),
    );
    expect(result).toBe(false);
  });

  test('overnight window: 22:00-06:00, at 22:00 is within quiet hours', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '22:00',
        quietEnd: '06:00',
      },
      new Date('2026-04-15T22:00:00Z'),
    );
    expect(result).toBe(true);
  });

  test('overnight window: 22:00-06:00, at 05:59 is within quiet hours', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '22:00',
        quietEnd: '06:00',
      },
      new Date('2026-04-15T05:59:00Z'),
    );
    expect(result).toBe(true);
  });

  test('overnight window: 22:00-06:00, at 06:00 is OUTSIDE quiet hours', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '22:00',
        quietEnd: '06:00',
      },
      new Date('2026-04-15T06:00:00Z'),
    );
    expect(result).toBe(false);
  });

  test('full-day window (00:00-00:00) always returns true', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '00:00',
        quietEnd: '00:00',
      },
      new Date('2026-04-15T14:30:00Z'),
    );
    expect(result).toBe(true);
  });

  test('null quietStart returns false', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: null,
        quietEnd: '17:00',
      },
      new Date('2026-04-15T12:00:00Z'),
    );
    expect(result).toBe(false);
  });

  test('null quietEnd returns false', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '09:00',
        quietEnd: null,
      },
      new Date('2026-04-15T12:00:00Z'),
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid time format handling
// ---------------------------------------------------------------------------

describe('invalid quiet hour time formats', () => {
  test('time with hours > 23 is treated as invalid (returns false)', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '99:00',
        quietEnd: '06:00',
      },
      new Date('2026-04-15T12:00:00Z'),
    );
    expect(result).toBe(false);
  });

  test('time with minutes > 59 is treated as invalid (returns false)', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '22:00',
        quietEnd: '06:99',
      },
      new Date('2026-04-15T23:00:00Z'),
    );
    expect(result).toBe(false);
  });

  test('malformed time string (no colon) returns false', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '2200',
        quietEnd: '0600',
      },
      new Date('2026-04-15T12:00:00Z'),
    );
    expect(result).toBe(false);
  });

  test('empty time string returns false', () => {
    const result = isWithinQuietHours(
      {
        muted: false,
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
        quietStart: '',
        quietEnd: '',
      },
      new Date('2026-04-15T12:00:00Z'),
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Preference merging across scopes
// ---------------------------------------------------------------------------

describe('preference scope merging', () => {
  test('type-scope overrides source-scope which overrides global-scope', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [
            {
              id: 'global',
              userId: 'user-1',
              scope: 'global',
              muted: false,
              pushEnabled: true,
              emailEnabled: true,
              inAppEnabled: true,
              updatedAt: new Date(),
            },
            {
              id: 'source',
              userId: 'user-1',
              scope: 'source',
              source: 'community',
              muted: false,
              pushEnabled: false,
              emailEnabled: true,
              inAppEnabled: false,
              updatedAt: new Date(),
            },
            {
              id: 'type',
              userId: 'user-1',
              scope: 'type',
              type: 'community:mention',
              muted: true,
              pushEnabled: true,
              emailEnabled: false,
              inAppEnabled: true,
              updatedAt: new Date(),
            },
          ];
        },
      } as unknown as NotificationPreferenceAdapter,
      'user-1',
      'community',
      'community:mention',
      { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
    );

    // Type scope has muted:true → muted wins
    expect(prefs.muted).toBe(true);
    // Type scope has pushEnabled:true → overrides source's false
    expect(prefs.pushEnabled).toBe(true);
    // Type scope has emailEnabled:false → overrides source's true
    expect(prefs.emailEnabled).toBe(false);
    // Type scope has inAppEnabled:true → overrides source's false
    expect(prefs.inAppEnabled).toBe(true);
  });

  test('source-scope without matching source does not apply', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [
            {
              id: 'source',
              userId: 'user-1',
              scope: 'source',
              source: 'different-source',
              muted: true,
              pushEnabled: true,
              emailEnabled: true,
              inAppEnabled: true,
              updatedAt: new Date(),
            },
          ];
        },
      } as unknown as NotificationPreferenceAdapter,
      'user-1',
      'community',
      'community:mention',
      { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
    );

    // Source doesn't match → defaults apply
    expect(prefs.muted).toBe(false);
  });

  test('type-scope without matching type does not apply', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [
            {
              id: 'type',
              userId: 'user-1',
              scope: 'type',
              type: 'other:type',
              muted: true,
              pushEnabled: true,
              emailEnabled: true,
              inAppEnabled: true,
              updatedAt: new Date(),
            },
          ];
        },
      } as unknown as NotificationPreferenceAdapter,
      'user-1',
      'community',
      'community:mention',
      { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
    );

    // Type doesn't match → defaults apply
    expect(prefs.muted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default fallback chain
// ---------------------------------------------------------------------------

describe('default preference fallback chain', () => {
  test('no preferences records returns all defaults', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [];
        },
      } as unknown as NotificationPreferenceAdapter,
      'user-1',
      'community',
      'community:mention',
      undefined,
    );

    expect(prefs.muted).toBe(false);
    expect(prefs.pushEnabled).toBe(true);
    expect(prefs.emailEnabled).toBe(true);
    expect(prefs.inAppEnabled).toBe(true);
    expect(prefs.quietStart).toBeNull();
    expect(prefs.quietEnd).toBeNull();
  });

  test('custom defaults are respected when no preference records exist', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [];
        },
      } as unknown as NotificationPreferenceAdapter,
      'user-1',
      'community',
      'community:mention',
      { pushEnabled: false, emailEnabled: false, inAppEnabled: false },
    );

    expect(prefs.pushEnabled).toBe(false);
    expect(prefs.emailEnabled).toBe(false);
    expect(prefs.inAppEnabled).toBe(false);
  });

  test('DEFAULT_NOTIFICATION_PREFERENCE is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_PREFERENCE)).toBe(true);
  });

  test('preference records with only partial fields still apply correctly', async () => {
    const prefs = await resolvePreferences(
      {
        async resolveForNotification() {
          return [
            {
              id: 'partial',
              userId: 'user-1',
              scope: 'global',
              muted: true,
              pushEnabled: true,
              emailEnabled: undefined as unknown as boolean,
              inAppEnabled: undefined as unknown as boolean,
              updatedAt: new Date(),
            },
          ];
        },
      } as unknown as NotificationPreferenceAdapter,
      'user-1',
      'community',
      'community:mention',
      { pushEnabled: true, emailEnabled: true, inAppEnabled: true },
    );

    expect(prefs.muted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Priority resolution during quiet hours
// ---------------------------------------------------------------------------

describe('effective priority resolution edge cases', () => {
  test('urgent priority is not downgraded during quiet hours', () => {
    const prefs = {
      muted: false,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
      quietStart: '22:00',
      quietEnd: '06:00',
    };
    const result = resolveEffectivePriority('urgent', prefs, new Date('2026-04-15T23:30:00Z'));
    expect(result).toBe('urgent');
  });

  test('high priority is downgraded to low during quiet hours', () => {
    const prefs = {
      muted: false,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
      quietStart: '22:00',
      quietEnd: '06:00',
    };
    const result = resolveEffectivePriority('high', prefs, new Date('2026-04-15T23:30:00Z'));
    expect(result).toBe('low');
  });

  test('normal priority is downgraded to low during quiet hours', () => {
    const prefs = {
      muted: false,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
      quietStart: '22:00',
      quietEnd: '06:00',
    };
    const result = resolveEffectivePriority('normal', prefs, new Date('2026-04-15T23:30:00Z'));
    expect(result).toBe('low');
  });

  test('low priority stays low even outside quiet hours', () => {
    const prefs = {
      muted: false,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
      quietStart: '22:00',
      quietEnd: '06:00',
    };
    const result = resolveEffectivePriority('low', prefs, new Date('2026-04-15T12:00:00Z'));
    expect(result).toBe('low');
  });
});
