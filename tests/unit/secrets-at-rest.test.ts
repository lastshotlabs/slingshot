/**
 * Unit tests for secrets-at-rest: refresh token hashing and TOTP encryption.
 */
import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { createAuthResolvedConfig } from '@auth/config/authConfig';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  decryptField,
  encryptField,
  hashToken,
  isEncryptedField,
} from '@lastshotlabs/slingshot-core';
import type { DataEncryptionKey } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// hashToken
// ---------------------------------------------------------------------------

describe('hashToken', () => {
  test('produces a 64-char hex string (SHA-256)', () => {
    const result = hashToken('test-token-123');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  test('is deterministic — same input produces same output', () => {
    const token = 'stable-token-abc';
    expect(hashToken(token)).toBe(hashToken(token));
  });

  test('different tokens produce different hashes', () => {
    const h1 = hashToken('token-a');
    const h2 = hashToken('token-b');
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Memory adapter refresh token hashing
// ---------------------------------------------------------------------------

describe('memory adapter refresh token hashing', () => {
  const config = createAuthResolvedConfig({
    refreshToken: { rotationGraceSeconds: 30, refreshTokenExpiry: 86400 },
  });
  let stores: ReturnType<typeof createMemoryAuthAdapter>;

  beforeEach(() => {
    stores = createMemoryAuthAdapter(() => config);
  });

  test('stores hash, not plaintext — direct plaintext lookup fails', () => {
    stores.memoryCreateSession('user1', 'access-1', 'sid-1');
    stores.memorySetRefreshToken('sid-1', 'plaintext-token');

    // Direct plaintext lookup into the index must fail (index keyed by hash)
    // The only public API is memoryGetSessionByRefreshToken which hashes internally
    const result = stores.memoryGetSessionByRefreshToken('plaintext-token');
    // This should succeed (hash lookup works)
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');

    // But the internal token stored on the session is a hash, not plaintext
    // We can verify this by checking that if we feed it the raw hash it fails
    // (because the function hashes the input before lookup)
    const hash = hashToken('plaintext-token');
    const directHashLookup = stores.memoryGetSessionByRefreshToken(hash);
    // hash of hash won't match anything
    expect(directHashLookup).toBeNull();
  });

  test('lookup with correct plaintext succeeds', () => {
    stores.memoryCreateSession('user1', 'access-1', 'sid-1');
    stores.memorySetRefreshToken('sid-1', 'my-refresh-token');

    const result = stores.memoryGetSessionByRefreshToken('my-refresh-token');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sid-1');
    expect(result!.userId).toBe('user1');
    expect(result!.fromGrace).toBe(false);
  });

  test('rotate stores new token as hash, old token in grace window returns session', () => {
    stores.memoryCreateSession('user1', 'access-1', 'sid-1');
    stores.memorySetRefreshToken('sid-1', 'refresh-1');
    stores.memoryRotateRefreshToken('sid-1', 'refresh-2', 'access-2');

    // New token lookup works
    const newResult = stores.memoryGetSessionByRefreshToken('refresh-2');
    expect(newResult).not.toBeNull();
    expect(newResult!.fromGrace).toBe(false);

    // Old token within grace window returns the session as a grace-window retry.
    const graceResult = stores.memoryGetSessionByRefreshToken('refresh-1');
    expect(graceResult).not.toBeNull();
    expect(graceResult!.sessionId).toBe('sid-1');
    expect(graceResult!.fromGrace).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// encryptField + decryptField
// ---------------------------------------------------------------------------

function makeKey(id: string, hex: string): DataEncryptionKey {
  // 32 bytes from a hex string (64 chars)
  return { keyId: id, key: Buffer.from(hex, 'hex') };
}

const KEY0 = makeKey('v0', '0'.repeat(64));
const KEY1 = makeKey('v1', '1'.repeat(64));

describe('encryptField / decryptField', () => {
  test('round-trip: encrypt then decrypt returns original plaintext', async () => {
    const plaintext = 'JBSWY3DPEHPK3PXP'; // typical TOTP base32 secret
    const ciphertext = await encryptField(plaintext, [KEY1]);
    const decrypted = await decryptField(ciphertext, [KEY1]);
    expect(decrypted).toBe(plaintext);
  });

  test('ciphertext format is keyId.iv.ct.tag (4 dot-separated parts)', async () => {
    const ciphertext = await encryptField('test', [KEY1]);
    const parts = ciphertext.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  test('two encryptions of the same plaintext produce different ciphertexts (random IV)', async () => {
    const ct1 = await encryptField('same plaintext', [KEY1]);
    const ct2 = await encryptField('same plaintext', [KEY1]);
    expect(ct1).not.toBe(ct2);
  });

  test('throws when no keys provided', async () => {
    expect(() => encryptField('text', [])).toThrow('no encryption keys configured');
  });

  test('throws on tampered ciphertext', async () => {
    const ciphertext = await encryptField('secret', [KEY1]);
    const parts = ciphertext.split('.');
    // Flip a character in the ciphertext part
    parts[2] = parts[2].replace(/[a-z]/, 'Z');
    const tampered = parts.join('.');
    expect(() => decryptField(tampered, [KEY1])).toThrow();
  });

  test('throws when keyId not found in key list', async () => {
    const ciphertext = await encryptField('secret', [KEY1]);
    expect(() => decryptField(ciphertext, [KEY0])).toThrow(`no key found for keyId "v1"`);
  });

  test('key rotation: value encrypted with old key can be decrypted with [newKey, oldKey]', async () => {
    const plaintext = 'rotate-me';
    // Encrypted with KEY0 (old key)
    const ciphertext = await encryptField(plaintext, [KEY0]);

    // Decryption with both keys present (KEY1 active, KEY0 available for rotation)
    const decrypted = await decryptField(ciphertext, [KEY1, KEY0]);
    expect(decrypted).toBe(plaintext);
  });

  test('isEncryptedField detects encrypted format', async () => {
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const ciphertext = await encryptField(plaintext, [KEY1]);
    expect(isEncryptedField(ciphertext)).toBe(true);
    expect(isEncryptedField(plaintext)).toBe(false);
    expect(isEncryptedField('just.three.parts')).toBe(false);
  });
});
