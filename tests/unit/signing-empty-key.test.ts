import { describe, expect, test } from 'bun:test';
import { hmacSign, hmacVerify } from '../../src/lib/signing';

describe('hmacSign — empty/falsy key guard', () => {
  test('throws when called with an empty array', () => {
    expect(() => hmacSign('data', [])).toThrow('hmacSign: secret key must be a non-empty string');
  });

  test('throws when called with an array containing only an empty string', () => {
    expect(() => hmacSign('data', [''])).toThrow('hmacSign: secret key must be a non-empty string');
  });

  test('throws when the first key in the array is an empty string (rotation array)', () => {
    // Even with a valid fallback key at index 1, the active signing key is index 0
    expect(() => hmacSign('data', ['', 'valid-secret-key-32-chars-minimum!'])).toThrow(
      'hmacSign: secret key must be a non-empty string',
    );
  });

  test('normal operation: signs with a valid string key', () => {
    const result = hmacSign('hello', 'a-valid-secret-key-that-is-long-enough');
    expect(typeof result).toBe('string');
    expect(result.length).toBe(64); // SHA-256 hex digest is always 64 chars
  });

  test('normal operation: signs with a valid array key', () => {
    const result = hmacSign('hello', ['a-valid-secret-key-that-is-long-enough']);
    expect(typeof result).toBe('string');
    expect(result.length).toBe(64);
  });
});

describe('hmacVerify — empty/falsy key guard', () => {
  const validSecret = 'a-valid-secret-key-that-is-long-enough';
  const data = 'some-data';
  const validSig = hmacSign(data, validSecret);

  test('returns false when called with an empty array (not throws)', () => {
    // hmacVerify is non-throwing by convention — invalid inputs return false
    expect(hmacVerify(data, validSig, [])).toBe(false);
  });

  test('returns false when called with an array containing only empty strings', () => {
    expect(hmacVerify(data, validSig, [''])).toBe(false);
  });

  test('returns false when all keys in the rotation array are empty strings', () => {
    expect(hmacVerify(data, validSig, ['', ''])).toBe(false);
  });

  test('skips falsy keys and still verifies with a valid key in the rotation array', () => {
    // A rotation array with an empty key followed by a valid key: the valid key should work
    expect(hmacVerify(data, validSig, ['', validSecret])).toBe(true);
  });

  test('normal operation: verifies with a valid string key', () => {
    expect(hmacVerify(data, validSig, validSecret)).toBe(true);
  });

  test('normal operation: verifies with a valid array key', () => {
    expect(hmacVerify(data, validSig, [validSecret])).toBe(true);
  });

  test('normal operation: returns false for a wrong signature', () => {
    expect(hmacVerify(data, 'wrong-sig', validSecret)).toBe(false);
  });

  test('normal operation: key rotation — accepts sig from an older key', () => {
    const oldSecret = 'old-secret-key-that-is-long-enough-xx';
    const newSecret = 'new-secret-key-that-is-long-enough-xx';
    const sigFromOldKey = hmacSign(data, oldSecret);
    // New key first, old key second — should still verify
    expect(hmacVerify(data, sigFromOldKey, [newSecret, oldSecret])).toBe(true);
  });
});
