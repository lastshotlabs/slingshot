/**
 * Tests for deepLinksConfigSchema validation and compileDeepLinksConfig.
 */
import { describe, expect, test } from 'bun:test';
import { compileDeepLinksConfig, deepLinksConfigSchema } from '../src/config';

describe('deepLinksConfigSchema — valid configs', () => {
  test('accepts minimal Apple-only config', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/share/*'] },
    });
    expect(result.success).toBe(true);
  });

  test('accepts minimal Android-only config', () => {
    const result = deepLinksConfigSchema.safeParse({
      android: {
        packageName: 'com.example.app',
        sha256Fingerprints: [
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts apple as single object (shorthand)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(result.success).toBe(true);
  });

  test('accepts apple as array of multiple bundles', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: [
        { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/share/*'] },
        { teamId: 'AAABBBCCCC', bundleId: 'com.example.app.clips', paths: ['/clip/*'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('accepts fallback config with base URL', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
      fallbackBaseUrl: 'https://example.com',
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts both apple and android together', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
      android: {
        packageName: 'com.example.app',
        sha256Fingerprints: [
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('deepLinksConfigSchema — invalid configs', () => {
  test('rejects empty object (nothing provided)', () => {
    const result = deepLinksConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects fallbackRedirects without fallbackBaseUrl', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects teamId with wrong format (lowercase)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'aaabbbcccc', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects teamId shorter than 10 chars', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'SHORT', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid bundleId format (not reverse DNS)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'not-reverse-dns', paths: ['/'] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects sha256 fingerprint with wrong format', () => {
    const result = deepLinksConfigSchema.safeParse({
      android: {
        packageName: 'com.example.app',
        sha256Fingerprints: ['notafingerprint'],
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty sha256Fingerprints array', () => {
    const result = deepLinksConfigSchema.safeParse({
      android: { packageName: 'com.example.app', sha256Fingerprints: [] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty paths array', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: [] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects http fallbackBaseUrl (requires https)', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
      fallbackBaseUrl: 'http://example.com',
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects fallbackBaseUrl with trailing slash', () => {
    const result = deepLinksConfigSchema.safeParse({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
      fallbackBaseUrl: 'https://example.com/',
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    expect(result.success).toBe(false);
  });
});

describe('compileDeepLinksConfig — normalization', () => {
  test('normalizes single apple object to array', () => {
    const config = compileDeepLinksConfig({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(Array.isArray(config.apple)).toBe(true);
    expect(config.apple).toHaveLength(1);
  });

  test('preserves array of multiple apple entries', () => {
    const config = compileDeepLinksConfig({
      apple: [
        { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/share/*'] },
        { teamId: 'AAABBBCCCC', bundleId: 'com.example.clips', paths: ['/clip/*'] },
      ],
    });
    expect(config.apple).toHaveLength(2);
  });

  test('freezes the resulting config', () => {
    const config = compileDeepLinksConfig({
      apple: { teamId: 'AAABBBCCCC', bundleId: 'com.example.app', paths: ['/'] },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('throws on invalid input', () => {
    expect(() =>
      compileDeepLinksConfig({ apple: { teamId: 'bad', bundleId: 'bad', paths: [] } }),
    ).toThrow();
  });
});
