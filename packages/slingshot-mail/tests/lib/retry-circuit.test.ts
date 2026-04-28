import { describe, expect, test } from 'bun:test';
import { MailCircuitOpenError, createMailCircuitBreaker } from '../../src/lib/circuitBreaker';
import { extractRetryAfterHeader, parseRetryAfterMs } from '../../src/lib/retryAfter';

describe('mail retry helpers', () => {
  test('parses retry-after seconds, dates, and invalid values', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('-1')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();

    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfterMs(future)).toBeGreaterThan(0);
  });

  test('extracts retry-after from Headers and plain objects', () => {
    expect(extractRetryAfterHeader(new Headers({ 'Retry-After': '3' }))).toBe('3');
    expect(extractRetryAfterHeader({ 'retry-after': '4' })).toBe('4');
    expect(extractRetryAfterHeader({ 'Retry-After': ['5'] })).toBe('5');
    expect(extractRetryAfterHeader(null)).toBeUndefined();
    expect(extractRetryAfterHeader({ 'Retry-After': [42] })).toBeUndefined();
  });

  test('opens after threshold failures, reports retry delay, and recovers on half-open success', async () => {
    let now = 1_000;
    const breaker = createMailCircuitBreaker({
      providerName: 'resend',
      threshold: 2,
      cooldownMs: 500,
      now: () => now,
    });

    await expect(breaker.guard(async () => Promise.reject(new Error('first')))).rejects.toThrow(
      'first',
    );
    await expect(breaker.guard(async () => Promise.reject(new Error('second')))).rejects.toThrow(
      'second',
    );

    expect(breaker.getHealth()).toMatchObject({
      state: 'open',
      consecutiveFailures: 2,
      openedAt: 1_000,
      nextProbeAt: 1_500,
    });

    await expect(breaker.guard(async () => 'blocked')).rejects.toMatchObject({
      name: 'MailCircuitOpenError',
      providerName: 'resend',
      retryAfterMs: 500,
    });

    now = 1_600;
    await expect(breaker.guard(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.getHealth()).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: undefined,
      nextProbeAt: undefined,
    });
  });

  test('half-open failure reopens the circuit', async () => {
    let now = 10_000;
    const breaker = createMailCircuitBreaker({
      providerName: 'postmark',
      threshold: 1,
      cooldownMs: 100,
      now: () => now,
    });

    await expect(breaker.guard(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    now = 10_200;
    await expect(breaker.guard(async () => Promise.reject(new Error('probe')))).rejects.toThrow(
      'probe',
    );

    expect(breaker.getHealth()).toMatchObject({
      state: 'open',
      consecutiveFailures: 2,
      openedAt: 10_200,
      nextProbeAt: 10_300,
    });
  });

  test('MailCircuitOpenError exposes operational details', () => {
    const err = new MailCircuitOpenError('open', 'ses', 123);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('MAIL_CIRCUIT_OPEN');
    expect(err.providerName).toBe('ses');
    expect(err.retryAfterMs).toBe(123);
  });
});
