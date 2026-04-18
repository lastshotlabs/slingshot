import { describe, expect, test } from 'bun:test';
import { sha256, timingSafeEqual } from '@lastshotlabs/slingshot-core';

describe('sha256', () => {
  test('returns consistent hex digest', () => {
    const hash = sha256('hello');
    expect(hash).toBe(sha256('hello'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('produces different outputs for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('timingSafeEqual', () => {
  test('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  test('returns false for same-length different strings', () => {
    expect(timingSafeEqual('abc', 'xyz')).toBe(false);
  });

  test('returns false for different-length strings', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });
});
