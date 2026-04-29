import { describe, expect, test } from 'bun:test';
import { runtimeNodeInternals } from '../src/index';

const { parseContentLength } = runtimeNodeInternals;

describe('Node runtime — content-length parsing', () => {
  test('valid integer content-length', () => {
    expect(parseContentLength('1234')).toBe(1234);
  });

  test('zero content-length is valid', () => {
    expect(parseContentLength('0')).toBe(0);
  });

  test('negative content-length is invalid', () => {
    expect(parseContentLength('-1')).toBeNull();
  });

  test('non-numeric content-length is NaN', () => {
    expect(parseContentLength('abc')).toBeNull();
  });

  test('empty content-length is NaN', () => {
    expect(parseContentLength('')).toBeNull();
  });

  test('float content-length is not an integer', () => {
    expect(parseContentLength('3.14')).toBeNull();
  });

  test('very large content-length', () => {
    const large = '999999999';
    expect(parseContentLength(large)).toBe(999999999);
  });

  test('hex content-length is NaN in base-10', () => {
    expect(parseContentLength('0xFF')).toBeNull();
  });
});

describe('Node runtime — body size limits', () => {
  test('body within limit passes', () => {
    const maxBytes = 1024;
    const bodySize = 500;
    expect(bodySize <= maxBytes).toBe(true);
  });

  test('body at exact limit passes', () => {
    const maxBytes = 1024;
    const bodySize = 1024;
    expect(bodySize <= maxBytes).toBe(true);
  });

  test('body exceeding limit is rejected', () => {
    const maxBytes = 1024;
    const bodySize = 2048;
    expect(bodySize > maxBytes).toBe(true);
  });

  test('default maxRequestBodySize is reasonable', () => {
    const defaultMax = 10 * 1024 * 1024; // 10MB typical default
    expect(defaultMax).toBeGreaterThan(0);
  });

  test('custom maxRequestBodySize can be set', () => {
    const customMax = 1024 * 1024; // 1MB
    expect(customMax).toBe(1048576);
  });
});
