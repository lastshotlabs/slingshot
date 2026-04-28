import { describe, expect, it } from 'bun:test';
import {
  HeaderInjectionError,
  sanitizeHeaderValue,
  sanitizeLogValue,
} from '../src/lib/sanitize';

describe('sanitizeHeaderValue', () => {
  it('returns the input unchanged when it is safe', () => {
    expect(sanitizeHeaderValue('hello world')).toBe('hello world');
    expect(sanitizeHeaderValue('Bearer abc.def-ghi=')).toBe('Bearer abc.def-ghi=');
    expect(sanitizeHeaderValue('')).toBe('');
  });

  it('throws on CR, LF, and CRLF injection attempts', () => {
    expect(() => sanitizeHeaderValue('foo\r\nX-Injected: yes')).toThrow(HeaderInjectionError);
    expect(() => sanitizeHeaderValue('foo\nX-Injected: yes')).toThrow(HeaderInjectionError);
    expect(() => sanitizeHeaderValue('foo\rbar')).toThrow(HeaderInjectionError);
  });

  it('throws on embedded NUL bytes', () => {
    expect(() => sanitizeHeaderValue('foo\0bar')).toThrow(HeaderInjectionError);
  });

  it('includes the header name in the error when supplied', () => {
    try {
      sanitizeHeaderValue('foo\r\nX-Injected: yes', 'X-Some-Header');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HeaderInjectionError);
      const headerErr = err as HeaderInjectionError;
      expect(headerErr.header).toBe('X-Some-Header');
      expect(headerErr.message).toContain('X-Some-Header');
      // Must NOT echo the attacker-controlled bytes back into the message.
      expect(headerErr.message).not.toContain('X-Injected');
    }
  });
});

describe('sanitizeLogValue', () => {
  it('returns the input unchanged when it is safe', () => {
    expect(sanitizeLogValue('hello world')).toBe('hello world');
    expect(sanitizeLogValue('id-1234')).toBe('id-1234');
  });

  it('escapes CR, LF, and NUL so log lines cannot be split', () => {
    expect(sanitizeLogValue('foo\r\nbar')).toBe('foo\\r\\nbar');
    expect(sanitizeLogValue('foo\nbar')).toBe('foo\\nbar');
    expect(sanitizeLogValue('foo\0bar')).toBe('foo\\0bar');
    // Combined attack payload from the audit task brief.
    expect(sanitizeLogValue('foo\r\nX-Injected: yes')).toBe('foo\\r\\nX-Injected: yes');
  });

  it('coerces non-string values without throwing', () => {
    expect(sanitizeLogValue(42)).toBe('42');
    expect(sanitizeLogValue(null)).toBe('null');
    expect(sanitizeLogValue(undefined)).toBe('undefined');
  });

  it('never throws — logging must always succeed', () => {
    const obj = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(() => sanitizeLogValue(obj)).not.toThrow();
    expect(sanitizeLogValue(obj)).toBe('<unstringifiable>');
  });
});
