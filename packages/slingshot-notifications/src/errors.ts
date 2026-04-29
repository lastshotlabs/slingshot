/** Errors thrown by the notifications plugin. */

export { NotificationDataTooLargeError, freezeNotificationData } from './data';

/**
 * Error thrown when a notification delivery attempt fails after exhausting
 * all retry attempts (e.g., the downstream provider rejected the event).
 */
export class NotificationDeliveryError extends Error {
  readonly code = 'NOTIFICATION_DELIVERY_ERROR';

  constructor(
    message: string,
    readonly notificationId: string,
    readonly userId: string,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NotificationDeliveryError';
  }
}

/**
 * Error thrown when a notification dispatch tick exceeds its time budget
 * and is aborted before all rows could be processed.
 */
export class NotificationDispatchTimeoutError extends Error {
  readonly code = 'NOTIFICATION_DISPATCH_TIMEOUT';

  constructor(
    readonly processedCount: number,
    readonly totalPending: number,
    readonly elapsedMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `Notification dispatch tick timed out after ${elapsedMs}ms — processed ${processedCount}/${totalPending} rows`,
      options,
    );
    this.name = 'NotificationDispatchTimeoutError';
  }
}

/**
 * Error thrown when a per-source, per-user rate limit is exceeded during a
 * notify call, and the calling code opts into throwing rather than silently
 * dropping the notification.
 */
export class NotificationRateLimitExceededError extends Error {
  readonly code = 'NOTIFICATION_RATE_LIMIT_EXCEEDED';

  constructor(
    readonly source: string,
    readonly userId: string,
    readonly limit: number,
    readonly windowMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `Rate limit exceeded for source="${source}" user="${userId}": ${limit} per ${windowMs}ms`,
      options,
    );
    this.name = 'NotificationRateLimitExceededError';
  }
}
