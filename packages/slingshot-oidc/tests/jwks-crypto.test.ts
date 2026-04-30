/**
 * Tests for OIDC JWKS key rotation, generateAndLoadKeyPair, getSigningPrivateKey,
 * and getVerifyPublicKeys with real crypto operations.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AuthResolvedConfig } from '@lastshotlabs/slingshot-auth';
import { HttpError } from '@lastshotlabs/slingshot-core';
import {
  generateAndLoadKeyPair,
  getJwks,
  getSigningPrivateKey,
  getVerifyPublicKeys,
  loadJwksKey,
  loadPreviousKey,
} from '../src/lib/jwks';
import { createOidcRouter } from '../src/routes/oidc';

function buildApp(cfg: AuthResolvedConfig) {
  const app = new Hono();
  app.route('/', createOidcRouter(cfg));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404 | 503);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });
  return app;
}

// ---------------------------------------------------------------------------
// Key rotation: primary + previous keys in JWKS response
// ---------------------------------------------------------------------------

describe('JWKS key rotation', () => {
  let primaryKeyPair: { privateKey: string; publicKey: string };
  let previousKeyPair: { privateKey: string; publicKey: string };
  let configWithRotation: AuthResolvedConfig;

  beforeAll(async () => {
    // Generate two independent key pairs to simulate rotation
    const primary = await generateAndLoadKeyPair({ issuer: 'https://auth.example.com' } as never);
    primaryKeyPair = { privateKey: primary.privateKey, publicKey: primary.publicKey };

    const previous = await generateAndLoadKeyPair({ issuer: 'https://auth.example.com' } as never);
    previousKeyPair = { privateKey: previous.privateKey, publicKey: previous.publicKey };

    // Build a config with primary key + one previous key
    let oidcConfig = primary.oidc;
    oidcConfig = loadPreviousKey(oidcConfig, {
      publicKey: previousKeyPair.publicKey,
      kid: 'key-prev-1',
    });

    configWithRotation = {
      oidc: { ...oidcConfig, issuer: 'https://auth.example.com' },
    } as AuthResolvedConfig;
  });

  test('JWKS endpoint returns both primary and previous keys', async () => {
    const app = buildApp(configWithRotation);
    const res = await app.request('/.well-known/jwks.json');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toBeArray();
    expect(body.keys.length).toBe(2);

    // Primary key should be first
    const [primaryJwk, previousJwk] = body.keys;
    expect(primaryJwk.kid).toBe('key-1');
    expect(primaryJwk.kty).toBe('RSA');
    expect(primaryJwk.alg).toBe('RS256');
    expect(primaryJwk.use).toBe('sig');

    // Previous key
    expect(previousJwk.kid).toBe('key-prev-1');
    expect(previousJwk.kty).toBe('RSA');
    expect(previousJwk.alg).toBe('RS256');
    expect(previousJwk.use).toBe('sig');
  });

  test('getJwks returns primary and previous keys via the library function', async () => {
    const jwks = await getJwks(configWithRotation);
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys[0].kid).toBe('key-1');
    expect(jwks.keys[1].kid).toBe('key-prev-1');

    // All keys should have RSA modulus data
    for (const key of jwks.keys) {
      expect(key.n).toBeString();
      expect(key.e).toBeString();
    }
  });

  test('multiple previous keys are all included in JWKS', async () => {
    // Generate a third key pair for a second previous key
    const third = await generateAndLoadKeyPair({ issuer: 'https://auth.example.com' } as never);

    let oidcConfig = configWithRotation.oidc!;
    oidcConfig = loadPreviousKey(oidcConfig, {
      publicKey: third.publicKey,
      kid: 'key-prev-2',
    });

    const multiConfig = { oidc: oidcConfig } as AuthResolvedConfig;
    const jwks = await getJwks(multiConfig);
    expect(jwks.keys).toHaveLength(3);
    expect(jwks.keys.map(k => k.kid)).toEqual(['key-1', 'key-prev-1', 'key-prev-2']);
  });
});

// ---------------------------------------------------------------------------
// generateAndLoadKeyPair
// ---------------------------------------------------------------------------

describe('generateAndLoadKeyPair', () => {
  test('generates valid PEM key pairs', async () => {
    const result = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);

    expect(result.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(result.privateKey).toContain('-----END PRIVATE KEY-----');
    expect(result.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(result.publicKey).toContain('-----END PUBLIC KEY-----');
  });

  test('sets the signing key on the returned oidc config', async () => {
    const result = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);

    expect(result.oidc.signingKey).toBeDefined();
    expect(result.oidc.signingKey!.privateKey).toBe(result.privateKey);
    expect(result.oidc.signingKey!.publicKey).toBe(result.publicKey);
    expect(result.oidc.signingKey!.kid).toBe('key-1');
  });

  test('preserves the original oidc config fields', async () => {
    const baseConfig = { issuer: 'https://test.com', scopes: ['openid', 'email'] };
    const result = await generateAndLoadKeyPair(baseConfig as never);

    expect(result.oidc.issuer).toBe('https://test.com');
    expect(result.oidc.scopes).toEqual(['openid', 'email']);
  });

  test('generates different keys on each call', async () => {
    const first = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const second = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);

    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).not.toBe(second.publicKey);
  });
});

// ---------------------------------------------------------------------------
// getSigningPrivateKey with actual crypto operations
// ---------------------------------------------------------------------------

describe('getSigningPrivateKey', () => {
  test('returns a CryptoKey from a config with a valid signing key', async () => {
    const { oidc } = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const config = { oidc } as AuthResolvedConfig;

    const privateKey = await getSigningPrivateKey(config);

    expect(privateKey).toBeDefined();
    // CryptoKey objects have an algorithm and type property
    expect(privateKey.algorithm).toBeDefined();
    expect(privateKey.type).toBe('private');
    expect(privateKey.usages).toContain('sign');
  });

  test('throws when no signing key is configured', async () => {
    const config = { oidc: { issuer: 'https://test.com' } } as AuthResolvedConfig;

    await expect(getSigningPrivateKey(config)).rejects.toThrow(
      'RS256 requires OIDC key configuration',
    );
  });

  test('throws when config is undefined', async () => {
    await expect(getSigningPrivateKey(undefined)).rejects.toThrow(
      'RS256 requires OIDC key configuration',
    );
  });
});

// ---------------------------------------------------------------------------
// getVerifyPublicKeys with multiple keys
// ---------------------------------------------------------------------------

describe('getVerifyPublicKeys', () => {
  test('returns the primary public key when only one key is configured', async () => {
    const { oidc } = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const config = { oidc } as AuthResolvedConfig;

    const keys = await getVerifyPublicKeys(config);

    expect(keys).toHaveLength(1);
    expect(keys[0].type).toBe('public');
    expect(keys[0].usages).toContain('verify');
  });

  test('returns primary + previous keys in order', async () => {
    const primary = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const prev = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);

    let oidcConfig = primary.oidc;
    oidcConfig = loadPreviousKey(oidcConfig, {
      publicKey: prev.publicKey,
      kid: 'key-prev-1',
    });

    const config = { oidc: oidcConfig } as AuthResolvedConfig;
    const keys = await getVerifyPublicKeys(config);

    expect(keys).toHaveLength(2);
    // All should be public verification keys
    for (const key of keys) {
      expect(key.type).toBe('public');
      expect(key.usages).toContain('verify');
    }
  });

  test('returns empty array when no keys are configured', async () => {
    const config = { oidc: { issuer: 'https://test.com' } } as AuthResolvedConfig;
    const keys = await getVerifyPublicKeys(config);
    expect(keys).toEqual([]);
  });

  test('returns empty array when config is undefined', async () => {
    const keys = await getVerifyPublicKeys(undefined);
    expect(keys).toEqual([]);
  });

  test('returns only previous keys when no primary is configured but previousKeys exist', async () => {
    const prev = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const config = {
      oidc: {
        issuer: 'https://test.com',
        previousKeys: [{ publicKey: prev.publicKey, kid: 'old-key' }],
      },
    } as AuthResolvedConfig;

    const keys = await getVerifyPublicKeys(config);
    expect(keys).toHaveLength(1);
    expect(keys[0].type).toBe('public');
  });

  test('handles multiple previous keys', async () => {
    const primary = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const prev1 = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);
    const prev2 = await generateAndLoadKeyPair({ issuer: 'https://test.com' } as never);

    let oidcConfig = primary.oidc;
    oidcConfig = loadPreviousKey(oidcConfig, { publicKey: prev1.publicKey, kid: 'prev-1' });
    oidcConfig = loadPreviousKey(oidcConfig, { publicKey: prev2.publicKey, kid: 'prev-2' });

    const config = { oidc: oidcConfig } as AuthResolvedConfig;
    const keys = await getVerifyPublicKeys(config);
    expect(keys).toHaveLength(3);
  });
});
