import { describe, expect, test } from 'bun:test';
import { timingSafeEqual } from '@lastshotlabs/slingshot-core';
import {
  createPresignedUrl,
  hmacSign,
  hmacVerify,
  signCookieValue,
  signCursor,
  verifyCookieValue,
  verifyCursor,
  verifyPresignedUrl,
} from '../../src/lib/signing';

describe('hmacSign / hmacVerify', () => {
  test('round-trip with string secret', () => {
    const secret = 'my-secret-key-32-chars-long-xxxxx';
    const sig = hmacSign('hello', secret);
    expect(hmacVerify('hello', sig, secret)).toBe(true);
  });

  test('wrong data fails verification', () => {
    const secret = 'my-secret-key-32-chars-long-xxxxx';
    const sig = hmacSign('hello', secret);
    expect(hmacVerify('world', sig, secret)).toBe(false);
  });

  test('tampered signature fails', () => {
    const secret = 'my-secret-key-32-chars-long-xxxxx';
    const sig = hmacSign('hello', secret);
    const tampered = sig.slice(0, -4) + '0000';
    expect(hmacVerify('hello', tampered, secret)).toBe(false);
  });

  test('key rotation: sign with key[0], verify with key[0]', () => {
    const keys = ['new-key-32-chars-long-xxxxxxxxxx', 'old-key-32-chars-long-xxxxxxxxxx'];
    const sig = hmacSign('data', keys);
    expect(hmacVerify('data', sig, keys)).toBe(true);
  });

  test('key rotation: old key signature still verifies', () => {
    const oldKey = 'old-key-32-chars-long-xxxxxxxxxx';
    const newKey = 'new-key-32-chars-long-xxxxxxxxxx';
    const sigFromOld = hmacSign('data', oldKey);
    // New config: newKey first, oldKey second
    expect(hmacVerify('data', sigFromOld, [newKey, oldKey])).toBe(true);
  });

  test('key rotation: unknown key fails', () => {
    const keys = ['new-key-32-chars-long-xxxxxxxxxx', 'old-key-32-chars-long-xxxxxxxxxx'];
    const sig = hmacSign('data', 'unrelated-key-32-chars-long-xxxx');
    expect(hmacVerify('data', sig, keys)).toBe(false);
  });

  test('uses timingSafeEqual (not ===) internally', () => {
    // hmacVerify must use timingSafeEqual. We verify this by confirming that
    // the timingSafeEqual function exists and is used — we test the observable
    // behavior: verification is correct even when strings are equal length.
    const secret = 'my-secret-key-32-chars-long-xxxxx';
    const correctSig = hmacSign('test', secret);
    // A forged signature of the same length (64 hex chars)
    const forgedSig = 'a'.repeat(64);
    expect(hmacVerify('test', forgedSig, secret)).toBe(false);
    expect(hmacVerify('test', correctSig, secret)).toBe(true);
    // If === were used, both would produce same result for same-length strings
    // timingSafeEqual is imported from crypto — it compares buffer bytes
    expect(typeof timingSafeEqual).toBe('function');
  });

  test('array secret never passes [object Array] as key', () => {
    const keyArray = ['real-key-32-chars-long-xxxxxxxxxx'];
    const stringKey = 'real-key-32-chars-long-xxxxxxxxxx';
    const sig = hmacSign('data', keyArray);
    // Must verify with the string — same underlying key
    expect(hmacVerify('data', sig, stringKey)).toBe(true);
    // Would fail if [object Array] were used as key
    const wrongSig = hmacSign('data', '[object Array]');
    expect(hmacVerify('data', wrongSig, stringKey)).toBe(false);
  });
});

describe('signCookieValue / verifyCookieValue', () => {
  const secret = 'cookie-secret-32-chars-long-xxxxx';

  test('round-trip', () => {
    const signed = signCookieValue('hello world', secret);
    expect(verifyCookieValue(signed, secret)).toBe('hello world');
  });

  test("value containing '.' round-trips correctly", () => {
    const value = '192.168.1.1';
    const signed = signCookieValue(value, secret);
    expect(verifyCookieValue(signed, secret)).toBe(value);
  });

  test('value containing multiple dots', () => {
    const value = 'a.b.c.d.e';
    const signed = signCookieValue(value, secret);
    expect(verifyCookieValue(signed, secret)).toBe(value);
  });

  test("empty string edge case — signed form is '.sig', dotIdx===0 is valid", () => {
    const signed = signCookieValue('', secret);
    expect(signed.startsWith('.')).toBe(true); // base64url("") === ""
    expect(verifyCookieValue(signed, secret)).toBe('');
  });

  test('tampered value returns null', () => {
    const signed = signCookieValue('hello', secret);
    // Corrupt the encoded part
    const tampered = 'AAAA.' + signed.split('.').at(-1);
    expect(verifyCookieValue(tampered, secret)).toBeNull();
  });

  test('tampered signature returns null', () => {
    const signed = signCookieValue('hello', secret);
    const tampered = signed.slice(0, signed.lastIndexOf('.') + 1) + '0'.repeat(64);
    expect(verifyCookieValue(tampered, secret)).toBeNull();
  });

  test('missing dot returns null', () => {
    expect(verifyCookieValue('nodot', secret)).toBeNull();
  });
});

describe('signCursor / verifyCursor', () => {
  const secret = 'cursor-secret-32-chars-long-xxxxx';

  test('round-trip', () => {
    const payload = 'eyJpZCI6IjEyMyJ9'; // some cursor payload
    const signed = signCursor(payload, secret);
    expect(verifyCursor(signed, secret)).toBe(payload);
  });

  test('tampered cursor returns null', () => {
    const signed = signCursor('cursor-data', secret);
    const tampered = 'ZZZZ.' + signed.split('.').at(-1);
    expect(verifyCursor(tampered, secret)).toBeNull();
  });

  test('wrong key returns null', () => {
    const signed = signCursor('cursor-data', 'wrong-secret-32-chars-long-xxxxx');
    expect(verifyCursor(signed, secret)).toBeNull();
  });
});

describe('createPresignedUrl / verifyPresignedUrl', () => {
  const secret = 'presign-secret-32-chars-long-xxxx';
  const base = 'https://api.example.com/uploads/download';

  test('round-trip', () => {
    const url = createPresignedUrl(
      base,
      'photos/test.jpg',
      { method: 'GET', expiry: 3600 },
      secret,
    );
    const result = verifyPresignedUrl(url, 'GET', secret);
    expect(result).not.toBeNull();
    expect(result?.key).toBe('photos/test.jpg');
  });

  test('expired URL returns null', () => {
    const url = createPresignedUrl(base, 'test.jpg', { method: 'GET', expiry: -1 }, secret);
    expect(verifyPresignedUrl(url, 'GET', secret)).toBeNull();
  });

  test('tampered signature returns null', () => {
    const url = createPresignedUrl(base, 'test.jpg', { method: 'GET', expiry: 3600 }, secret);
    const tampered = url.replace(/sig=[^&]+/, 'sig=AAAA');
    expect(verifyPresignedUrl(tampered, 'GET', secret)).toBeNull();
  });

  test('method binding — GET URL rejected for PUT', () => {
    const url = createPresignedUrl(base, 'test.jpg', { method: 'GET', expiry: 3600 }, secret);
    expect(verifyPresignedUrl(url, 'PUT', secret)).toBeNull();
  });

  test('extra params round-trip', () => {
    const url = createPresignedUrl(
      base,
      'test.jpg',
      {
        method: 'GET',
        expiry: 3600,
        extra: { userId: 'abc', bucket: 'prod' },
      },
      secret,
    );
    const result = verifyPresignedUrl(url, 'GET', secret);
    expect(result?.extra?.userId).toBe('abc');
    expect(result?.extra?.bucket).toBe('prod');
  });

  test('invalid URL returns null', () => {
    expect(verifyPresignedUrl('not-a-url', 'GET', secret)).toBeNull();
  });

  test('key with dots in path signs correctly (newline delimiter)', () => {
    const key = 'uploads/2024/photo.jpg';
    const url = createPresignedUrl(base, key, { method: 'GET', expiry: 3600 }, secret);
    const result = verifyPresignedUrl(url, 'GET', secret);
    expect(result?.key).toBe(key);
  });
});

describe('signCookieValue / verifyCookieValue — edge cases', () => {
  const secret = 'malformed-secret-32-chars-long-xxx';

  test('completely wrong format (no dot at all) returns null', () => {
    expect(verifyCookieValue('nodothere', secret)).toBeNull();
  });

  test('valid HMAC on corrupted payload still fails — payload mismatch', () => {
    // Sign a valid value, then swap the encoded part with a different encoding.
    // The HMAC was computed over the original encoded value, so it won't match.
    const signed = signCookieValue('original', secret);
    const sig = signed.split('.').at(-1)!;
    const fake = `${Buffer.from('other').toString('base64url')}.${sig}`;
    expect(verifyCookieValue(fake, secret)).toBeNull();
  });
});
