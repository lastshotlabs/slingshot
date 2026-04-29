import { describe, expect, test } from 'bun:test';
import { NotificationDataTooLargeError, freezeNotificationData, MAX_NOTIFICATION_DATA_BYTES } from '../src/data';

describe('NotificationDataTooLargeError', () => {
  test('is an Error instance', () => {
    const err = new NotificationDataTooLargeError(9000);
    expect(err).toBeInstanceOf(Error);
  });

  test('has code property', () => {
    const err = new NotificationDataTooLargeError(9000);
    expect(err.code).toBe('NOTIFICATION_DATA_TOO_LARGE');
  });

  test('includes byteLength in message', () => {
    const err = new NotificationDataTooLargeError(12345);
    expect(err.message).toContain('12345');
  });

  test('includes max bytes in message', () => {
    const err = new NotificationDataTooLargeError(100);
    expect(err.message).toContain(String(MAX_NOTIFICATION_DATA_BYTES));
  });

  test('exposes byteLength property', () => {
    const err = new NotificationDataTooLargeError(9999);
    expect(err.byteLength).toBe(9999);
  });
});

describe('freezeNotificationData', () => {
  test('freezes simple object', () => {
    const data = { title: 'Hello', body: 'World' };
    const frozen = freezeNotificationData(data);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.title).toBe('Hello');
  });

  test('returns a shallow copy (not the original)', () => {
    const data = { a: 1 };
    const frozen = freezeNotificationData(data);
    expect(frozen).not.toBe(data);
  });

  test('accepts empty object', () => {
    const frozen = freezeNotificationData({});
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  test('rejects data exceeding size limit', () => {
    const largeData = { payload: 'x'.repeat(MAX_NOTIFICATION_DATA_BYTES) };
    expect(() => freezeNotificationData(largeData)).toThrow(NotificationDataTooLargeError);
  });

  test('accepts data at the size limit boundary', () => {
    const small = { key: 'value' };
    expect(() => freezeNotificationData(small)).not.toThrow();
  });
});
