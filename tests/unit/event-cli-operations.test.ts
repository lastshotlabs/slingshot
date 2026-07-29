import { describe, expect, test } from 'bun:test';
import { durationBefore, requireExactConfirmation } from '../../src/cli/lib/events/operations';

describe('event operations CLI safety helpers', () => {
  test('requires exact app-name confirmation', () => {
    expect(() => requireExactConfirmation('payments-api', undefined)).toThrow('--confirm');
    expect(() => requireExactConfirmation('payments-api', 'Payments API')).toThrow('--confirm');
    expect(() => requireExactConfirmation('payments-api', 'payments-api')).not.toThrow();
  });

  test('parses bounded operator duration syntax', () => {
    const now = Date.parse('2026-07-29T00:00:00.000Z');
    expect(durationBefore('30m', now)).toBe('2026-07-28T23:30:00.000Z');
    expect(durationBefore('24h', now)).toBe('2026-07-28T00:00:00.000Z');
    expect(durationBefore('7d', now)).toBe('2026-07-22T00:00:00.000Z');
    expect(() => durationBefore('forever', now)).toThrow('Duration');
  });
});
