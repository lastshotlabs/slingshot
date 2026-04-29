import { describe, expect, it } from 'bun:test';
import { assertSafeMailHeaders, ensureSafe, formatSafeAddress } from '../../src/lib/headerSanitize';
import { MailSendError } from '../../src/types/provider';

describe('formatSafeAddress', () => {
  it('returns plain strings unchanged', () => {
    expect(formatSafeAddress('user@example.com')).toBe('user@example.com');
  });

  it('formats display-name addresses', () => {
    expect(formatSafeAddress({ name: 'Alice', email: 'a@example.com' })).toBe(
      'Alice <a@example.com>',
    );
  });

  it('rejects CRLF in display name as MailSendError (non-retryable)', () => {
    try {
      formatSafeAddress({ name: 'Alice\r\nBcc: evil@example.com', email: 'a@example.com' }, 'From');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MailSendError);
      expect((err as MailSendError).retryable).toBe(false);
    }
  });

  it('rejects CRLF in email field', () => {
    expect(() =>
      formatSafeAddress({ name: 'Alice', email: 'a@example.com\r\nBcc: evil@example.com' }, 'To'),
    ).toThrow(MailSendError);
  });

  it('rejects NUL bytes', () => {
    expect(() => formatSafeAddress({ name: 'Alice\0', email: 'a@example.com' })).toThrow(
      MailSendError,
    );
  });
});

describe('ensureSafe', () => {
  it('returns safe input unchanged', () => {
    expect(ensureSafe('Hello world', 'Subject')).toBe('Hello world');
  });

  it('rejects CRLF injection payload', () => {
    expect(() => ensureSafe('foo\r\nX-Injected: yes', 'Subject')).toThrow(MailSendError);
  });
});

describe('assertSafeMailHeaders', () => {
  it('accepts a clean message', () => {
    expect(() =>
      assertSafeMailHeaders({
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>hi</p>',
        headers: { 'X-Tag': 'release' },
      }),
    ).not.toThrow();
  });

  it('rejects CRLF in subject', () => {
    expect(() =>
      assertSafeMailHeaders({
        to: 'recipient@example.com',
        subject: 'Hello\r\nBcc: evil@example.com',
        html: '<p>hi</p>',
      }),
    ).toThrow(MailSendError);
  });

  it('rejects CRLF in custom header value', () => {
    expect(() =>
      assertSafeMailHeaders({
        to: 'recipient@example.com',
        subject: 'Hello',
        html: '<p>hi</p>',
        headers: { 'X-Tag': 'release\r\nX-Injected: yes' },
      }),
    ).toThrow(MailSendError);
  });
});
