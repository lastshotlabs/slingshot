import { describe, expect, it } from 'bun:test';
import {
  bytesToBase64Url,
  generateSecurePassword,
  secureRandomBytes,
  secureRandomString,
} from '../src/lib/secureRandom';

// ---------------------------------------------------------------------------
// secureRandomBytes
// ---------------------------------------------------------------------------

describe('secureRandomBytes', () => {
  it('returns a Uint8Array of the requested length', () => {
    const bytes = secureRandomBytes(16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
  });

  it('produces unique outputs across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(Buffer.from(secureRandomBytes(16)).toString('hex'));
    }
    expect(seen.size).toBe(1000);
  });

  it('throws RangeError for non-positive byteLength', () => {
    expect(() => secureRandomBytes(0)).toThrow(RangeError);
    expect(() => secureRandomBytes(-1)).toThrow(RangeError);
    expect(() => secureRandomBytes(1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// bytesToBase64Url
// ---------------------------------------------------------------------------

describe('bytesToBase64Url', () => {
  it('encodes empty input as empty string', () => {
    expect(bytesToBase64Url(new Uint8Array(0))).toBe('');
  });

  it('produces only URL-safe base64 characters', () => {
    const out = bytesToBase64Url(secureRandomBytes(64));
    expect(/^[A-Za-z0-9_-]+$/.test(out)).toBe(true);
  });

  it('matches Node Buffer base64url for known input', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10]);
    const expected = Buffer.from(bytes).toString('base64url');
    expect(bytesToBase64Url(bytes)).toBe(expected);
  });

  it('matches Node Buffer base64url for random inputs of varying length', () => {
    for (const len of [1, 2, 3, 4, 5, 16, 17, 31, 32]) {
      const bytes = secureRandomBytes(len);
      const expected = Buffer.from(bytes).toString('base64url');
      expect(bytesToBase64Url(bytes)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// generateSecurePassword
// ---------------------------------------------------------------------------

describe('generateSecurePassword', () => {
  it('returns a non-empty base64url string', () => {
    const pw = generateSecurePassword(16);
    expect(typeof pw).toBe('string');
    expect(pw.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9_-]+$/.test(pw)).toBe(true);
  });

  it('1000 calls produce unique outputs of expected length using only base64url alphabet', () => {
    const start = performance.now();
    const seen = new Set<string>();
    const expectedLen = Math.ceil((24 * 4) / 3); // 24 bytes → 32 base64url chars
    for (let i = 0; i < 1000; i++) {
      const pw = generateSecurePassword(24);
      expect(pw.length).toBe(expectedLen);
      expect(/^[A-Za-z0-9_-]+$/.test(pw)).toBe(true);
      seen.add(pw);
    }
    const elapsed = performance.now() - start;
    expect(seen.size).toBe(1000);
    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// secureRandomString
// ---------------------------------------------------------------------------

describe('secureRandomString', () => {
  it('returns empty string for length 0', () => {
    expect(secureRandomString(0, 'abc')).toBe('');
  });

  it('produces a string of the requested length', () => {
    const s = secureRandomString(50, 'abcdef');
    expect(s.length).toBe(50);
  });

  it('only uses characters from the provided alphabet', () => {
    const alphabet = 'XYZ123';
    const s = secureRandomString(200, alphabet);
    for (const ch of s) {
      expect(alphabet).toContain(ch);
    }
  });

  it('1000 calls of a 32-char alphanumeric password are unique, well-formed, and fast', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const start = performance.now();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const pw = secureRandomString(32, alphabet);
      expect(pw.length).toBe(32);
      for (const ch of pw) {
        expect(alphabet).toContain(ch);
      }
      seen.add(pw);
    }
    const elapsed = performance.now() - start;
    expect(seen.size).toBe(1000);
    expect(elapsed).toBeLessThan(100);
  });

  it('distributes characters roughly uniformly across the alphabet', () => {
    const alphabet = 'ABCDEFGH'; // 8 chars
    const s = secureRandomString(8000, alphabet);
    const counts = new Map<string, number>();
    for (const ch of s) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    // Expected ~1000 per char; allow generous tolerance for randomness.
    for (const ch of alphabet) {
      const c = counts.get(ch) ?? 0;
      expect(c).toBeGreaterThan(700);
      expect(c).toBeLessThan(1300);
    }
  });

  it('throws RangeError on invalid arguments', () => {
    expect(() => secureRandomString(-1, 'abc')).toThrow(RangeError);
    expect(() => secureRandomString(1.5, 'abc')).toThrow(RangeError);
    expect(() => secureRandomString(10, '')).toThrow(RangeError);
  });
});
