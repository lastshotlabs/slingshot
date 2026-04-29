import { describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

/**
 * Tests for the Node runtime's argon2-based password hashing.
 *
 * These complement the smoke tests by exercising argon2-specific behavior:
 * hash format, edge case inputs, and verification stability across
 * sequential calls.
 *
 * The argon2 module import error path (when the peer dep is not installed)
 * cannot be tested via mock.module in this file because mock.module affects
 * the entire process and would break subsequent tests. That path is covered
 * by manual verification: createNodePassword() dynamically imports argon2
 * at call time, so if the module is absent, the import promise rejects and
 * the error surfaces synchronously to the caller.
 */

describe('runtime-node password (argon2)', () => {
  const runtime = nodeRuntime();

  test('hash produces a string starting with the argon2id marker', async () => {
    const hash = await runtime.password.hash('password123');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    // argon2id hashes start with $argon2id$v=19$m=...
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  test('verify returns true for the correct password', async () => {
    const hash = await runtime.password.hash('correct-password');
    expect(await runtime.password.verify('correct-password', hash)).toBe(true);
  });

  test('verify returns false for an incorrect password', async () => {
    const hash = await runtime.password.hash('real-password');
    expect(await runtime.password.verify('wrong-password', hash)).toBe(false);
  });

  test('verify returns false for a malformed hash string', async () => {
    const result = await runtime.password.verify('password', 'not-a-valid-hash');
    expect(result).toBe(false);
  });

  test('verify returns false for a completely empty hash', async () => {
    const result = await runtime.password.verify('password', '');
    expect(result).toBe(false);
  });

  test('verify returns false for a truncated hash', async () => {
    const fullHash = await runtime.password.hash('test');
    const truncated = fullHash.slice(0, 20);
    const result = await runtime.password.verify('test', truncated);
    expect(result).toBe(false);
  });

  test('each hash call produces a unique output (random salt)', async () => {
    const hash1 = await runtime.password.hash('same-password');
    const hash2 = await runtime.password.hash('same-password');
    expect(hash1).not.toBe(hash2);
  });

  test('handles empty string password', async () => {
    const hash = await runtime.password.hash('');
    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify('', hash)).toBe(true);
    expect(await runtime.password.verify('not-empty', hash)).toBe(false);
  });

  test('handles very long password (500 characters)', async () => {
    const longPassword = 'x'.repeat(500);
    const hash = await runtime.password.hash(longPassword);
    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify(longPassword, hash)).toBe(true);
    expect(await runtime.password.verify(longPassword + 'wrong', hash)).toBe(false);
  });

  test('handles password with special characters', async () => {
    const special = 'p@ssw0rd!$%^*()_+-=[]{}|;:,.<>?/~`"\' ';
    const hash = await runtime.password.hash(special);
    expect(await runtime.password.verify(special, hash)).toBe(true);
  });

  test('handles password with unicode characters', async () => {
    const unicode = 'passwort-中文-日本語-한국어-emoji😀';
    const hash = await runtime.password.hash(unicode);
    expect(await runtime.password.verify(unicode, hash)).toBe(true);
  });

  test('verify with the same hash is stable across multiple calls', async () => {
    const hash = await runtime.password.hash('stable-password');
    for (let i = 0; i < 5; i++) {
      expect(await runtime.password.verify('stable-password', hash)).toBe(true);
      expect(await runtime.password.verify('wrong', hash)).toBe(false);
    }
  });

  test('hash and verify work correctly with whitespace passwords', async () => {
    const passwords = [' leading', 'trailing ', ' both ', '   ', '\t', '\n'];
    for (const pw of passwords) {
      const hash = await runtime.password.hash(pw);
      expect(await runtime.password.verify(pw, hash)).toBe(true);
    }
  });

  test('verify returns false for a hash with wrong algorithm prefix', async () => {
    const hash = await runtime.password.hash('test');
    // Replace the argon2id prefix with something unrecognizable
    const corrupted = '$2b$04$' + hash.slice(hash.lastIndexOf('$') + 1);
    const result = await runtime.password.verify('test', corrupted);
    expect(result).toBe(false);
  });

  test('verify returns false when hash format is completely garbage', async () => {
    const garbage = '\\x00\\x01\\x02' + 'a'.repeat(60) + '\\xff';
    const result = await runtime.password.verify('anything', garbage);
    expect(result).toBe(false);
  });
});
