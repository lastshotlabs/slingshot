import { describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

describe('password', () => {
  const runtime = bunRuntime({ installProcessSafetyNet: false });

  test('hash returns a non-empty string', async () => {
    const hash = await runtime.password.hash('secure-password');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  test('verify returns true for correct password', async () => {
    const hash = await runtime.password.hash('correct-password');
    const result = await runtime.password.verify('correct-password', hash);
    expect(result).toBe(true);
  });

  test('verify returns false for wrong password', async () => {
    const hash = await runtime.password.hash('correct-password');
    const result = await runtime.password.verify('wrong-password', hash);
    expect(result).toBe(false);
  });

  test('verify returns false for malformed hash string (no throw)', async () => {
    const result = await runtime.password.verify('any-password', 'not-a-valid-hash-value');
    expect(result).toBe(false);
  });

  test('verify returns false for empty hash (no throw)', async () => {
    const result = await runtime.password.verify('any-password', '');
    expect(result).toBe(false);
  });

  test('verify returns false for invalid hash prefix (no throw)', async () => {
    const result = await runtime.password.verify('password', '$2b$04$thisisnotavalidhashformat');
    expect(result).toBe(false);
  });

  test('repeated hashing of same input produces distinct hashes', async () => {
    const h1 = await runtime.password.hash('same-input');
    const h2 = await runtime.password.hash('same-input');
    // Each call should generate a fresh salt, so hashes differ
    expect(h1).not.toBe(h2);
  });

  test('verify returns false when hash is a very long invalid string', async () => {
    const longJunk = 'x' + '0'.repeat(500);
    const result = await runtime.password.verify('password', longJunk);
    expect(result).toBe(false);
  });
});
