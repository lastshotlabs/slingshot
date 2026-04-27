import { describe, expect, test } from 'bun:test';
import type { AuthResolvedConfig } from '@lastshotlabs/slingshot-auth';
import { loadJwksKey, loadPreviousKey } from '../src/lib/jwks';
// isJwksLoaded is an internal helper — import from source
import { isJwksLoaded } from '../src/lib/jwks';

const fakePem = {
  privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  publicKey: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
};

function makeOidcConfig(overrides?: Partial<AuthResolvedConfig['oidc']>): AuthResolvedConfig {
  return { oidc: { issuer: 'https://example.com', ...overrides } } as AuthResolvedConfig;
}

// ---------------------------------------------------------------------------
// isJwksLoaded
// ---------------------------------------------------------------------------

describe('isJwksLoaded', () => {
  test('returns false when config is undefined', () => {
    expect(isJwksLoaded(undefined)).toBe(false);
  });

  test('returns false when oidc is not configured', () => {
    expect(isJwksLoaded({} as AuthResolvedConfig)).toBe(false);
  });

  test('returns false when signingKey is absent', () => {
    expect(isJwksLoaded(makeOidcConfig())).toBe(false);
  });

  test('returns true when signingKey is present', () => {
    expect(isJwksLoaded(makeOidcConfig({ signingKey: fakePem }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadJwksKey
// ---------------------------------------------------------------------------

describe('loadJwksKey', () => {
  test('returns a new config object with signingKey set', () => {
    const base = { issuer: 'https://example.com' };
    const result = loadJwksKey(base as never, fakePem);
    expect(result.signingKey).toBe(fakePem);
  });

  test('does not mutate the original config', () => {
    const base = { issuer: 'https://example.com' };
    const before = { ...base };
    loadJwksKey(base as never, fakePem);
    expect(base).toEqual(before);
  });

  test('overwrites an existing signingKey', () => {
    const base = {
      issuer: 'https://example.com',
      signingKey: { privateKey: 'old', publicKey: 'old' },
    };
    const newKey = { privateKey: 'new', publicKey: 'new', kid: 'key-2' };
    const result = loadJwksKey(base as never, newKey);
    expect(result.signingKey).toBe(newKey);
  });
});

// ---------------------------------------------------------------------------
// loadPreviousKey
// ---------------------------------------------------------------------------

describe('loadPreviousKey', () => {
  test('creates previousKeys array when not present', () => {
    const base = { issuer: 'https://example.com' };
    const key = {
      publicKey: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
      kid: 'prev-1',
    };
    const result = loadPreviousKey(base as never, key);
    expect(result.previousKeys).toEqual([key]);
  });

  test('appends to an existing previousKeys array without mutating original', () => {
    const existing = { publicKey: 'old', kid: 'prev-1' };
    const base = { issuer: 'https://example.com', previousKeys: [existing] };
    const newKey = { publicKey: 'new', kid: 'prev-2' };
    const result = loadPreviousKey(base as never, newKey);
    expect(result.previousKeys).toEqual([existing, newKey]);
    expect(base.previousKeys).toEqual([existing]);
  });

  test('does not mutate the original config', () => {
    const base = { issuer: 'https://example.com', previousKeys: [] };
    const before = { ...base, previousKeys: [...base.previousKeys] };
    loadPreviousKey(base as never, { publicKey: 'k' });
    expect(base).toEqual(before);
  });
});
