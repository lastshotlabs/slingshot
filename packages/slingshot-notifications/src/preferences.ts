import { deepFreeze } from '@lastshotlabs/slingshot-core';
import type {
  NotificationPreferenceAdapter,
  NotificationPreferenceDefaults,
  NotificationPreferenceRecord,
  NotificationPriority,
  ResolvedPreference,
} from './types';

const FALLBACK_PREFERENCE_DEFAULTS: NotificationPreferenceDefaults = Object.freeze({
  pushEnabled: true,
  emailEnabled: true,
  inAppEnabled: true,
});

function buildDefaultPreference(defaults: NotificationPreferenceDefaults): ResolvedPreference {
  return {
    muted: false,
    pushEnabled: defaults.pushEnabled,
    emailEnabled: defaults.emailEnabled,
    inAppEnabled: defaults.inAppEnabled,
    quietStart: null,
    quietEnd: null,
  };
}

const DEFAULT_PREFERENCE: ResolvedPreference = Object.freeze(
  buildDefaultPreference(FALLBACK_PREFERENCE_DEFAULTS),
);

export const DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS: NotificationPreferenceDefaults =
  Object.freeze({
    ...FALLBACK_PREFERENCE_DEFAULTS,
  });

export const DEFAULT_NOTIFICATION_PREFERENCE: ResolvedPreference = Object.freeze({
  muted: false,
  pushEnabled: true,
  emailEnabled: true,
  inAppEnabled: true,
  quietStart: null,
  quietEnd: null,
});

function applyPreference(record: NotificationPreferenceRecord): ResolvedPreference {
  return {
    muted: record.muted,
    pushEnabled: record.pushEnabled,
    emailEnabled: record.emailEnabled,
    inAppEnabled: record.inAppEnabled,
    quietStart: record.quietStart ?? null,
    quietEnd: record.quietEnd ?? null,
  };
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Resolve the effective notification preference chain for one recipient.
 *
 * @param adapter - Preference adapter.
 * @param userId - Recipient user id.
 * @param source - Notification source.
 * @param type - Notification type.
 * @returns Resolved preference snapshot.
 */
export async function resolvePreferences(
  adapter: NotificationPreferenceAdapter,
  userId: string,
  source: string,
  type: string,
  defaults: NotificationPreferenceDefaults = DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS,
): Promise<ResolvedPreference> {
  const records = await adapter.resolveForNotification({ userId });

  let resolved: ResolvedPreference =
    defaults === DEFAULT_NOTIFICATION_PREFERENCE_DEFAULTS
      ? DEFAULT_PREFERENCE
      : buildDefaultPreference(defaults);
  const globalRecord = records.find(record => record.scope === 'global');
  if (globalRecord) {
    resolved = applyPreference(globalRecord);
  }

  const sourceRecord = records.find(
    record => record.scope === 'source' && record.source === source,
  );
  if (sourceRecord) {
    resolved = applyPreference(sourceRecord);
  }

  const typeRecord = records.find(record => record.scope === 'type' && record.type === type);
  if (typeRecord) {
    resolved = applyPreference(typeRecord);
  }

  return deepFreeze({ ...resolved });
}

/**
 * Returns whether the current time falls within quiet hours.
 *
 * @param prefs - Resolved preference snapshot.
 * @param now - Time to evaluate.
 * @returns `true` when within the quiet-hours range.
 */
export function isWithinQuietHours(prefs: ResolvedPreference, now: Date): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = timeToMinutes(prefs.quietStart);
  const end = timeToMinutes(prefs.quietEnd);
  if (start == null || end == null) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

/**
 * Downgrade standard-priority notifications during quiet hours.
 *
 * @param priority - Requested priority.
 * @param prefs - Resolved preference snapshot.
 * @param now - Time to evaluate.
 * @returns Effective priority after quiet-hours rules.
 */
export function resolveEffectivePriority(
  priority: NotificationPriority,
  prefs: ResolvedPreference,
  now: Date,
): NotificationPriority {
  if (priority === 'urgent') return priority;
  if (isWithinQuietHours(prefs, now)) return 'low';
  return priority;
}
