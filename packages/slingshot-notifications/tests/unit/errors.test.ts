import { describe, expect, test } from 'bun:test';
import {
  NotificationDeliveryError,
  NotificationDispatchTimeoutError,
  NotificationRateLimitExceededError,
} from '../../src/errors';

describe('notification errors', () => {
  test('NotificationDeliveryError exposes delivery context and cause', () => {
    const cause = new Error('provider failed');
    const err = new NotificationDeliveryError('delivery exhausted', 'n-1', 'user-1', 3, {
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NotificationDeliveryError');
    expect(err.code).toBe('NOTIFICATION_DELIVERY_ERROR');
    expect(err.message).toBe('delivery exhausted');
    expect(err.notificationId).toBe('n-1');
    expect(err.userId).toBe('user-1');
    expect(err.attempts).toBe(3);
    expect(err.cause).toBe(cause);
  });

  test('NotificationDispatchTimeoutError formats timeout progress', () => {
    const cause = new Error('clock budget');
    const err = new NotificationDispatchTimeoutError(12, 25, 5000, { cause });

    expect(err.name).toBe('NotificationDispatchTimeoutError');
    expect(err.code).toBe('NOTIFICATION_DISPATCH_TIMEOUT');
    expect(err.processedCount).toBe(12);
    expect(err.totalPending).toBe(25);
    expect(err.elapsedMs).toBe(5000);
    expect(err.message).toContain('processed 12/25 rows');
    expect(err.cause).toBe(cause);
  });

  test('NotificationRateLimitExceededError exposes rate-limit dimensions', () => {
    const err = new NotificationRateLimitExceededError('community', 'user-1', 5, 60_000);

    expect(err.name).toBe('NotificationRateLimitExceededError');
    expect(err.code).toBe('NOTIFICATION_RATE_LIMIT_EXCEEDED');
    expect(err.source).toBe('community');
    expect(err.userId).toBe('user-1');
    expect(err.limit).toBe(5);
    expect(err.windowMs).toBe(60_000);
    expect(err.message).toContain('source="community"');
    expect(err.message).toContain('user="user-1"');
  });
});
