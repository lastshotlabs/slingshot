// packages/runtime-edge/tests/unit/password-hashing.test.ts
//
// Tests for the internal PBKDF2-SHA-256 hashing implementation used by
// edgeRuntime(). All tests exercise the public password.hash / password.verify
// API because hashWithWebCrypto and verifyWithWebCrypto are not exported.
//
// Coverage areas:
//   - Embedded iteration count (PBKDF2_ITERATIONS = 600 000) in modern format
//   - Constant-time comparison (XOR diff loop)
//   - Modern format parse: pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>
//   - Legacy format parse: <salt-b64>:<hash-b64> with LEGACY_PBKDF2_ITERATIONS
//   - Returning false on any parse error (malformed, truncated, invalid, etc.)
//   - Roundtrip correctness for various input lengths and character classes
import { describe, expect, it } from 'bun:test';
import { edgeRuntime } from '../../src/index';

describe('password hashing (PBKDF2-SHA-256 internal)', () => {
  // -------------------------------------------------------------------------
  // Iteration count in modern format
  // -------------------------------------------------------------------------

  it('embeds PBKDF2_ITERATIONS (600_000) in the modern hash format', async () => {
    const runtime = edgeRuntime();
    const hash = await runtime.password.hash('any-password');
    // Modern format: pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>
    expect(hash).toMatch(/^pbkdf2-sha256\$600000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('modern-format hash verify uses the embedded iteration count', async () => {
    const runtime = edgeRuntime();
    const hash = await runtime.password.hash('roundtrip-test');
    // If verify parses the embedded iter count correctly it should match
    expect(await runtime.password.verify('roundtrip-test', hash)).toBe(true);
    expect(await runtime.password.verify('wrong', hash)).toBe(false);
  });

  it('roundtrip succeeds with a different embedded iteration count (500_000)', async () => {
    // Manually construct a hash with a non-default iteration count to prove
    // verify parses and uses the embedded value rather than a constant.
    const salt = new Uint8Array(16);
    const enc = new TextEncoder().encode('custom-iter');
    const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 500_000, hash: 'SHA-256' },
      key,
      256,
    );
    const saltB64 = btoa(Array.from(salt, b => String.fromCharCode(b)).join(''));
    const hashB64 = btoa(Array.from(new Uint8Array(bits), b => String.fromCharCode(b)).join(''));
    const modernHash = `pbkdf2-sha256$500000$${saltB64}$${hashB64}`;

    const runtime = edgeRuntime();
    expect(await runtime.password.verify('custom-iter', modernHash)).toBe(true);
    expect(await runtime.password.verify('wrong', modernHash)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Legacy two-part format (salt:hash) at LEGACY_PBKDF2_ITERATIONS (100 000)
  // -------------------------------------------------------------------------

  it('verifies a legacy two-part hash at the historical iteration count', async () => {
    const runtime = edgeRuntime();
    const enc = new TextEncoder().encode('legacy-pw');
    const salt = new Uint8Array(16);
    const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', iterations: 100_000, hash: 'SHA-256', salt },
      key,
      256,
    );
    const saltB64 = btoa(Array.from(salt, b => String.fromCharCode(b)).join(''));
    const hashB64 = btoa(Array.from(new Uint8Array(bits), b => String.fromCharCode(b)).join(''));
    const legacyHash = `${saltB64}:${hashB64}`;

    expect(await runtime.password.verify('legacy-pw', legacyHash)).toBe(true);
    expect(await runtime.password.verify('wrong-pw', legacyHash)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Constant-time comparison properties
  //
  // The implementation uses XOR reduction: diff |= actual[i] ^ expected[i].
  // We cannot reliably observe timing in a test, but we can verify the
  // semantic properties of the constant-time compare:
  //   - Same length with same bits → diff === 0 → true
  //   - Same length with differing bits → diff !== 0 → false
  //   - Different lengths caught by length check → false
  // -------------------------------------------------------------------------

  it('constant-time compare returns true for identical hashes', async () => {
    const runtime = edgeRuntime();
    const hash = await runtime.password.hash('ct-test');
    const result = await runtime.password.verify('ct-test', hash);
    expect(result).toBe(true);
  });

  it('constant-time compare returns false for different hash values', async () => {
    const runtime = edgeRuntime();
    // Use roundtrip then corrupt the hash body so the decoded lengths still
    // match (32 bytes) but the bits differ — exercises the XOR diff loop.
    const hash = await runtime.password.hash('original');
    // Replace the hash part with a different base64 of the same length.
    const parts = hash.split('$');
    const corruptHash = 'A'.repeat(parts[3].length); // same length, different bits
    parts[3] = corruptHash;
    const corrupted = parts.join('$');
    expect(await runtime.password.verify('original', corrupted)).toBe(false);
  });

  it('constant-time compare returns false when decoded-hash lengths differ', async () => {
    const runtime = edgeRuntime();
    const hash = await runtime.password.hash('padding');
    // Append extra base64 chars so decoded length exceeds 32 bytes.
    const parts = hash.split('$');
    parts[3] = parts[3] + 'AA'; // 2 extra chars -> 2 extra decoded bytes
    const corrupted = parts.join('$');
    expect(await runtime.password.verify('padding', corrupted)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Modern-format parse error handling (return false, never throw)
  // -------------------------------------------------------------------------

  it('returns false for empty stored hash', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', '')).toBe(false);
  });

  it('returns false for short prefix-only string', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256')).toBe(false);
  });

  it('returns false when modern hash has only 2 parts after prefix', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000$saltOnly')).toBe(false);
  });

  it('returns false when modern hash has 4+ parts after prefix', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000$salt$hash$extra')).toBe(false);
  });

  it('returns false when modern hash iteration count is NaN', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$notANumber$salt$hash')).toBe(false);
  });

  it('returns false when modern hash iteration count is a float', async () => {
    const runtime = edgeRuntime();
    // Number('600000.5') is not an integer
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000.5$salt$hash')).toBe(false);
  });

  it('returns false when modern hash iteration count is zero', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$0$salt$hash')).toBe(false);
  });

  it('returns false when modern hash iteration count is negative', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$-100$salt$hash')).toBe(false);
  });

  it('returns false when salt part is empty string in modern hash', async () => {
    const runtime = edgeRuntime();
    // salt is empty string — atob('') will decode to empty Uint8Array (length 0)
    // which will derive different bits than expected; the catch-all returns false.
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000$$hash')).toBe(false);
  });

  it('returns false when hash part is empty string in modern hash', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000$salt$')).toBe(false);
  });

  it('returns false for invalid base64 in salt part (modern format)', async () => {
    const runtime = edgeRuntime();
    // atob('!!!') throws, caught by the outer try/catch → returns false
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000$!!!$YWJj')).toBe(false);
  });

  it('returns false for invalid base64 in hash part (modern format)', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'pbkdf2-sha256$600000$YWJj$!!!')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Legacy-format parse error handling (return false, never throw)
  // -------------------------------------------------------------------------

  it('returns false for legacy hash with no colon separator', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'justsalt')).toBe(false);
  });

  it('returns false for legacy hash with three colon-separated parts', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'a:b:c')).toBe(false);
  });

  it('returns false for legacy hash with empty salt', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', ':hashValue')).toBe(false);
  });

  it('returns false for legacy hash with empty hash', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'saltValue:')).toBe(false);
  });

  it('returns false for legacy hash with invalid base64 in salt', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', '!!!:YWJj')).toBe(false);
  });

  it('returns false for legacy hash with invalid base64 in hash part', async () => {
    const runtime = edgeRuntime();
    expect(await runtime.password.verify('p', 'YWJj:!!!')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Input edge cases (correctly-formed hashes for various inputs)
  // -------------------------------------------------------------------------

  it('hashes and verifies an empty-string password', async () => {
    const runtime = edgeRuntime();
    const hash = await runtime.password.hash('');
    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify('', hash)).toBe(true);
  });

  it('hashes and verifies a very long password (10 000 chars)', async () => {
    const runtime = edgeRuntime();
    const longPw = 'x'.repeat(10_000);
    const hash = await runtime.password.hash(longPw);
    expect(typeof hash).toBe('string');
    expect(await runtime.password.verify(longPw, hash)).toBe(true);
    expect(await runtime.password.verify(longPw + 'extra', hash)).toBe(false);
  });

  it('hashes and verifies a password with unicode characters', async () => {
    const runtime = edgeRuntime();
    const unicodePw = 'pässwörd♥😀';
    const hash = await runtime.password.hash(unicodePw);
    expect(await runtime.password.verify(unicodePw, hash)).toBe(true);
  });

  it('hashes and verifies a password with all-ASCII special characters', async () => {
    const runtime = edgeRuntime();
    const specialPw = '!@#$%^&*()_+-=[]{}|;:,.<>?~`\'"\\';
    const hash = await runtime.password.hash(specialPw);
    expect(await runtime.password.verify(specialPw, hash)).toBe(true);
  });

  it('each hash() call produces a unique value (random salt)', async () => {
    const runtime = edgeRuntime();
    const hashes = await Promise.all(
      Array.from({ length: 10 }, () => runtime.password.hash('same-password')),
    );
    // All 10 hashes of the same password should be different due to random salt
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        expect(hashes[i]).not.toBe(hashes[j]);
      }
    }
  });

  it('verify never throws for any malformed hash input', async () => {
    const runtime = edgeRuntime();
    const nastyInputs = [
      null,
      undefined,
      '',
      'pbkdf2-sha256',
      'pbkdf2-sha256$',
      'pbkdf2-sha256$$$',
      ':::',
      ':',
      '\0',
      '\n',
      'valid-prefix$but$garbage',
      '%%%',
    ];
    for (const input of nastyInputs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await runtime.password.verify('p', input as any);
      expect(result).toBe(false);
    }
  });
});
