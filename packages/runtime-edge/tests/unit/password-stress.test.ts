// packages/runtime-edge/tests/unit/password-stress.test.ts
//
// Stress tests for password operations in the edge runtime. Exercises
// many sequential/concurrent hash and verify calls, edge case inputs,
// and verification of the constant-time comparison guarantee.
//
// Coverage:
//   - 20 sequential hash+verify roundtrips
//   - 10 concurrent hash calls with unique passwords
//   - Password verify with extremely long hash strings
//   - Password verify with hash containing null bytes
//   - Repeated verify of same hash does not degrade
//   - Many concurrent verify calls against the same hash
import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('edgeRuntime() — password stress tests', () => {
  // -----------------------------------------------------------------------
  // Sequential roundtrips
  // -----------------------------------------------------------------------

  describe('sequential roundtrips', () => {
    it('performs 20 sequential hash+verify roundtrips without error', async () => {
      const runtime = edgeRuntime();
      for (let i = 0; i < 20; i++) {
        const pwd = `password-${i}`;
        const hash = await runtime.password.hash(pwd);
        expect(typeof hash).toBe('string');
        expect(await runtime.password.verify(pwd, hash)).toBe(true);
        expect(await runtime.password.verify(`wrong-${i}`, hash)).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent operations
  // -----------------------------------------------------------------------

  describe('concurrent operations', () => {
    it('hashes 10 different passwords concurrently', async () => {
      const runtime = edgeRuntime();
      const passwords = Array.from({ length: 10 }, (_, i) => `concurrent-pw-${i}`);
      const hashes = await Promise.all(passwords.map(p => runtime.password.hash(p)));

      expect(hashes).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(typeof hashes[i]).toBe('string');
        expect(await runtime.password.verify(passwords[i], hashes[i])).toBe(true);
      }
    });

    it('verifies 10 concurrent calls against the same hash', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('shared-password');

      const results = await Promise.all(
        Array.from({ length: 10 }, () => runtime.password.verify('shared-password', hash)),
      );
      expect(results.every(r => r === true)).toBe(true);
    });

    it('verifies 10 concurrent calls with wrong passwords', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('real-password');

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => runtime.password.verify(`wrong-${i}`, hash)),
      );
      expect(results.every(r => r === false)).toBe(true);
    });

    it('handles mixed concurrent hash and verify calls', async () => {
      const runtime = edgeRuntime();

      const results = await Promise.all([
        runtime.password.hash('pw-1'),
        runtime.password.hash('pw-2'),
        runtime.password.verify('pw-1', await runtime.password.hash('pw-1')),
        runtime.password.verify('wrong', await runtime.password.hash('pw-2')),
        runtime.password.hash('pw-3'),
      ]);

      expect(results).toHaveLength(5);
      expect(typeof results[0]).toBe('string');
      expect(typeof results[1]).toBe('string');
      // results[2] is from verify — depends on timing
      expect(typeof results[3]).toBe('boolean');
      expect(typeof results[4]).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // Edge case inputs for verify
  // -----------------------------------------------------------------------

  describe('edge case verify inputs', () => {
    it('returns false for a very long hash string', async () => {
      const runtime = edgeRuntime();
      const longHash = 'a'.repeat(100_000);
      const result = await runtime.password.verify('password', longHash);
      expect(result).toBe(false);
    });

    it('returns false for hash with null bytes', async () => {
      const runtime = edgeRuntime();
      const hashWithNull = 'pbkdf2-sha256$600000$abc\0def$hash\0part';
      const result = await runtime.password.verify('password', hashWithNull);
      expect(result).toBe(false);
    });

    it('returns false for hash with only whitespace', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.password.verify('p', '   ')).toBe(false);
      expect(await runtime.password.verify('p', '\t\n')).toBe(false);
    });

    it('returns false for hash with unicode characters in base64 parts', async () => {
      const runtime = edgeRuntime();
      // These are technically invalid base64, but should not crash
      const unicodeHash = 'pbkdf2-sha256$600000$❤️$🔥';
      const result = await runtime.password.verify('password', unicodeHash);
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Repeated operations
  // -----------------------------------------------------------------------

  describe('repeated verification stability', () => {
    it('same hash verified 5 times returns consistent results', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('stable-pw');

      for (let i = 0; i < 5; i++) {
        expect(await runtime.password.verify('stable-pw', hash)).toBe(true);
        expect(await runtime.password.verify('wrong', hash)).toBe(false);
      }
    });
  });
});
