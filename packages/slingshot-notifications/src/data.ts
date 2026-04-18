import { deepFreeze } from '@lastshotlabs/slingshot-core';

export const MAX_NOTIFICATION_DATA_BYTES = 8 * 1024;

/**
 * Error thrown when notification data exceeds the size cap.
 */
export class NotificationDataTooLargeError extends Error {
  readonly code = 'NOTIFICATION_DATA_TOO_LARGE';

  constructor(readonly byteLength: number) {
    super(`notification.data exceeds ${MAX_NOTIFICATION_DATA_BYTES} bytes (got ${byteLength})`);
  }
}

/**
 * Freeze notification data after validating its JSON size.
 *
 * @param data - Notification display payload.
 * @returns Frozen notification data snapshot.
 */
export function freezeNotificationData(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(data);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_NOTIFICATION_DATA_BYTES) {
    throw new NotificationDataTooLargeError(byteLength);
  }

  return deepFreeze({ ...data });
}
