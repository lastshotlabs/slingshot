import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';
import {
  decryptField,
  encryptField,
  generateSecureToken,
  hashToken,
  hmacSign,
  isEncryptedField,
  sha256,
  timingSafeEqual,
} from '../../src/crypto';
import type { DataEncryptionKey } from '../../src/crypto';

describe('timingSafeEqual', () => {
  test('returns true for equal strings', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true);
  });

  test('returns false for different strings of same length', () => {
    expect(timingSafeEqual('hello', 'world')).toBe(false);
  });

  test('returns false for different length strings', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });

  test('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('sha256', () => {
  test('returns a 64-char hex string', () => {
    const hash = sha256('hello');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  test('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  test('different inputs produce different hashes', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('hmacSign', () => {
  test('signs with a string secret', () => {
    const sig = hmacSign('payload', 'secret');
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  test('signs with the first element of an array secret', () => {
    const sig1 = hmacSign('payload', 'key1');
    const sig2 = hmacSign('payload', ['key1', 'key2-rotated']);
    expect(sig1).toBe(sig2);
  });

  test('throws when secret is empty string', () => {
    expect(() => hmacSign('payload', '')).toThrow('secret key must be a non-empty string');
  });

  test('throws when secret array is empty', () => {
    expect(() => hmacSign('payload', [])).toThrow('secret key must be a non-empty string');
  });
});

describe('hashToken', () => {
  test('is an alias for sha256', () => {
    const token = 'my-token-123';
    expect(hashToken(token)).toBe(sha256(token));
  });
});

describe('encryptField / decryptField', () => {
  const key1: DataEncryptionKey = { keyId: 'k1', key: randomBytes(32) };
  const key2: DataEncryptionKey = { keyId: 'k2', key: randomBytes(32) };

  test('round-trip encrypt then decrypt', () => {
    const plaintext = 'sensitive-data';
    const ciphertext = encryptField(plaintext, [key1]);
    const decrypted = decryptField(ciphertext, [key1]);
    expect(decrypted).toBe(plaintext);
  });

  test('different plaintext produces different ciphertext', () => {
    const ct1 = encryptField('a', [key1]);
    const ct2 = encryptField('b', [key1]);
    expect(ct1).not.toBe(ct2);
  });

  test('same plaintext produces different ciphertext (random IV)', () => {
    const ct1 = encryptField('same', [key1]);
    const ct2 = encryptField('same', [key1]);
    expect(ct1).not.toBe(ct2);
  });

  test('key rotation: decrypt with old key after encrypting with new', () => {
    const ct = encryptField('secret', [key1]);
    // Decrypt with both keys available (key1 matches by keyId)
    const result = decryptField(ct, [key2, key1]);
    expect(result).toBe('secret');
  });

  test('encryptField throws with empty keyConfig', () => {
    expect(() => encryptField('data', [])).toThrow('no encryption keys configured');
  });

  test('decryptField throws with invalid format', () => {
    expect(() => decryptField('bad-format', [key1])).toThrow('invalid ciphertext format');
  });

  test('decryptField throws with unknown keyId', () => {
    const ct = encryptField('data', [key1]);
    expect(() => decryptField(ct, [key2])).toThrow('no key found for keyId');
  });

  test('decryptField detects tampered ciphertext via GCM auth tag', () => {
    const ct = encryptField('secret-data', [key1]);
    const parts = ct.split('.');
    // Tamper with the auth tag (last part)
    const tamperedTag = Buffer.from('0'.repeat(32), 'hex').toString('base64url');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${tamperedTag}`;
    expect(() => decryptField(tampered, [key1])).toThrow();
  });
});

describe('isEncryptedField', () => {
  test('returns true for 4-part dot-separated string', () => {
    expect(isEncryptedField('k1.iv.ct.tag')).toBe(true);
  });

  test('returns false for plain string', () => {
    expect(isEncryptedField('plain-text')).toBe(false);
  });

  test('returns false for 3-part string', () => {
    expect(isEncryptedField('a.b.c')).toBe(false);
  });
});

describe('generateSecureToken', () => {
  test('returns a 43-char base64url string', () => {
    const token = generateSecureToken();
    expect(token).toHaveLength(43);
  });

  test('each call produces a different token', () => {
    const t1 = generateSecureToken();
    const t2 = generateSecureToken();
    expect(t1).not.toBe(t2);
  });
});
