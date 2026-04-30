import { describe, expect, test } from 'bun:test';
import { edgeRuntime } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode N random bytes into a base64 string. */
function randomB64(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return btoa(Array.from(buf, b => String.fromCharCode(b)).join(''));
}

/** Build a modern-format hash from raw components. */
function modernHash(iter: number, saltB64: string, hashB64: string): string {
  return `pbkdf2-sha256$${iter}$${saltB64}$${hashB64}`;
}

// ---------------------------------------------------------------------------
// Shared runtime (defaults -> real Web Crypto PBKDF2)
// ---------------------------------------------------------------------------

const rt = edgeRuntime();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Edge runtime -- default password hashing (Web Crypto PBKDF2)', () => {
  // --------------------------------------------------
  //  1. Hash output format
  // --------------------------------------------------
  test('1. hash produces non-empty string with correct format prefix', async () => {
    const hash = await rt.password.hash('my-password');

    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');

    // Expected: pbkdf2-sha256$<iterations>$<base64-salt>$<base64-hash>
    expect(hash.startsWith('pbkdf2-sha256$')).toBe(true);

    const parts = hash.slice('pbkdf2-sha256$'.length).split('$');
    expect(parts).toHaveLength(3);

    const [iterStr, saltB64, hashB64] = parts;
    const iter = Number(iterStr);
    expect(Number.isInteger(iter)).toBe(true);
    expect(iter).toBeGreaterThanOrEqual(600_000); // matches OWASP-recommended minimum

    // Base64 should decode cleanly (16 bytes salt, 32 bytes hash)
    expect(atob(saltB64).length).toBe(16);
    expect(atob(hashB64).length).toBe(32);
  }, 30_000);

  // --------------------------------------------------
  //  2. Verify -- correct password
  // --------------------------------------------------
  test('2. verify returns true for correct password', async () => {
    const password = 'my-strong-p@ss!';
    const hash = await rt.password.hash(password);

    const ok = await rt.password.verify(password, hash);
    expect(ok).toBe(true);
  }, 30_000);

  // --------------------------------------------------
  //  3. Verify -- wrong password
  // --------------------------------------------------
  test('3. verify returns false for wrong password', async () => {
    const hash = await rt.password.hash('correct-password');

    const ok = await rt.password.verify('wrong-password', hash);
    expect(ok).toBe(false);
  }, 30_000);

  // --------------------------------------------------
  //  4. Legacy format (<salt>:<hash>)
  // --------------------------------------------------
  test('4. verify handles legacy format hashes (<salt>:<hash>)', async () => {
    const password = 'legacy-test-pwd';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      key,
      256,
    );
    const hashArr = new Uint8Array(bits);
    const saltB64 = btoa(Array.from(salt, b => String.fromCharCode(b)).join(''));
    const hashB64 = btoa(Array.from(hashArr, b => String.fromCharCode(b)).join(''));
    const legacyHash = `${saltB64}:${hashB64}`;

    // Correct password should verify
    expect(await rt.password.verify(password, legacyHash)).toBe(true);
    // Wrong password should not
    expect(await rt.password.verify('wrong-password', legacyHash)).toBe(false);
  }, 30_000);

  // --------------------------------------------------
  //  5. Constant-time comparison -- wrong-length hash
  // --------------------------------------------------
  test('5. constant-time comparison: verify with wrong-length hash returns false', async () => {
    // Legacy format: valid 16-byte salt but hash portion decodes to only 5 bytes.
    // PBKDF2 always produces 32 bytes, so the length guard before the XOR loop
    // (actualHash.length !== expectedHash.length) catches this.
    const wrongLenHash = `${randomB64(16)}:${randomB64(5)}`;
    expect(await rt.password.verify('anything', wrongLenHash)).toBe(false);
  }, 30_000);

  // --------------------------------------------------
  //  6. Empty password
  // --------------------------------------------------
  test('6. empty password can be hashed and verified', async () => {
    const hash = await rt.password.hash('');

    expect(hash).toBeTruthy();
    expect(hash.startsWith('pbkdf2-sha256$')).toBe(true);

    // Empty should match empty
    expect(await rt.password.verify('', hash)).toBe(true);
    // Non-empty should not match
    expect(await rt.password.verify('x', hash)).toBe(false);
    // Any other non-empty should also not match
    expect(await rt.password.verify('anything', hash)).toBe(false);
  }, 30_000);

  // --------------------------------------------------
  //  7. Very long passwords
  // --------------------------------------------------
  test('7. very long passwords (2 000 / 10 000 chars)', async () => {
    const longPwd = 'x'.repeat(2_000);
    const hash = await rt.password.hash(longPwd);

    expect(hash.startsWith('pbkdf2-sha256$')).toBe(true);
    expect(await rt.password.verify(longPwd, hash)).toBe(true);

    // Off-by-one at the end should fail
    const longPwd2 = 'x'.repeat(1_999) + 'y';
    expect(await rt.password.verify(longPwd2, hash)).toBe(false);

    // Even longer password (10 000 chars)
    const veryLong = 'ab'.repeat(5_000);
    const hash2 = await rt.password.hash(veryLong);
    expect(await rt.password.verify(veryLong, hash2)).toBe(true);
    expect(await rt.password.verify(veryLong + 'z', hash2)).toBe(false);
  }, 60_000);

  // --------------------------------------------------
  //  8. Unicode passwords
  // --------------------------------------------------
  test('8. unicode passwords (emoji, accented, CJK)', async () => {
    const passwords = [
      'héllo-wörld',
      'пароль', // Cyrillic
      '密码', // Chinese
      '🔑👍héllo', // Emoji + accented
      '日本語パスワード', // Japanese
      'à́', // Combining diacritics (a + grave + acute)
    ];

    for (const pwd of passwords) {
      const hash = await rt.password.hash(pwd);
      expect(await rt.password.verify(pwd, hash)).toBe(true);
      expect(await rt.password.verify(pwd + 'x', hash)).toBe(false);
    }
  }, 90_000);

  // --------------------------------------------------
  //  9. Null bytes in passwords
  // --------------------------------------------------
  test('9. passwords containing null bytes', async () => {
    const pwdWithNull = 'pass\x00word';
    const hash = await rt.password.hash(pwdWithNull);

    // Verify the exact password (with null byte)
    expect(await rt.password.verify(pwdWithNull, hash)).toBe(true);

    // A password without the null byte is a different credential
    expect(await rt.password.verify('password', hash)).toBe(false);
    expect(await rt.password.verify('password', hash)).toBe(false);

    // Null byte at different position
    const pwdNullStart = '\x00password';
    const hash2 = await rt.password.hash(pwdNullStart);
    expect(await rt.password.verify(pwdNullStart, hash2)).toBe(true);
    expect(await rt.password.verify('password', hash2)).toBe(false);
  }, 60_000);

  // --------------------------------------------------
  // 10. Malformed hash strings
  // --------------------------------------------------
  test('10. malformed hash strings return false without throwing', async () => {
    const malformed: string[] = [
      // --- completely invalid ---
      '',
      'not-a-hash',
      'garbage!!!',

      // --- modern format, wrong number of parts ---
      'pbkdf2-sha256$1000', // only 1 part after prefix
      'pbkdf2-sha256$1000$salt', // only 2 parts after prefix

      // --- modern format, invalid iterations ---
      'pbkdf2-sha256$abc$salt$hash', // non-numeric
      'pbkdf2-sha256$0.5$salt$hash', // not an integer
      'pbkdf2-sha256$0$salt$hash', // zero (not >= 1)
      'pbkdf2-sha256$-1$salt$hash', // negative

      // --- legacy format, wrong number of colons ---
      'salthash', // no colon
      'salt:hash:extra', // two colons

      // --- legacy format with invalid base64 (atob will throw) ---
      `${randomB64(16)}:!!!not-base64!!!`,

      // --- modern format with invalid base64 ---
      modernHash(1000, randomB64(16), '!!!not-base64!!!'),
    ];

    for (const h of malformed) {
      const result = await rt.password.verify('test', h);
      expect(result).toBe(false);
    }
  }, 15_000);

  // --------------------------------------------------
  // 11. Multiple hashes => different salts
  // --------------------------------------------------
  test('11. multiple hashes of same input produce different salts', async () => {
    const password = 'same-password';

    const hash1 = await rt.password.hash(password);
    const hash2 = await rt.password.hash(password);

    // Extract salt portions
    const extractSalt = (h: string): string => h.slice('pbkdf2-sha256$'.length).split('$')[1];

    const salt1 = extractSalt(hash1);
    const salt2 = extractSalt(hash2);

    // Salts must differ (randomness)
    expect(salt1).not.toBe(salt2);

    // Both must still verify
    expect(await rt.password.verify(password, hash1)).toBe(true);
    expect(await rt.password.verify(password, hash2)).toBe(true);
  }, 60_000);

  // --------------------------------------------------
  // 12. Tampered hash
  // --------------------------------------------------
  test('12. tampered hash (modified salt, hash, or iterations) returns false', async () => {
    const password = 'tamper-test';
    const hash = await rt.password.hash(password);

    const parts = hash.slice('pbkdf2-sha256$'.length).split('$');
    const [iterStr, saltB64, hashB64] = parts;

    // -- Tamper with salt (flip first base64 char) --
    const tamperedSalt = (saltB64[0] === 'A' ? 'B' : 'A') + saltB64.slice(1);
    const hashWithTamperedSalt = modernHash(Number(iterStr), tamperedSalt, hashB64);
    expect(await rt.password.verify(password, hashWithTamperedSalt)).toBe(false);

    // -- Tamper with hash output (flip first base64 char) --
    const tamperedHashB64 = (hashB64[0] === 'A' ? 'B' : 'A') + hashB64.slice(1);
    const hashWithTamperedHash = modernHash(Number(iterStr), saltB64, tamperedHashB64);
    expect(await rt.password.verify(password, hashWithTamperedHash)).toBe(false);

    // -- Tamper with iteration count (use 1 instead of 600k) --
    const hashWithLowIter = modernHash(1, saltB64, hashB64);
    expect(await rt.password.verify(password, hashWithLowIter)).toBe(false);

    // Also verify the original unchanged hash still works
    expect(await rt.password.verify(password, hash)).toBe(true);
  }, 30_000);
});
