import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import { generateAndLoadKeyPair } from '@auth/lib/jwks';
import { signToken, verifyToken } from '@auth/lib/jwt';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createOidcRouter } from '@lastshotlabs/slingshot-oidc';

let config: AuthResolvedConfig;

function buildOidcApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404);
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.route('/', createOidcRouter(config));
  return app;
}

beforeEach(() => {
  config = { ...DEFAULT_AUTH_CONFIG };
});

describe('RS256 signing', () => {
  test('signs and verifies with auto-generated key pair', async () => {
    config = {
      ...config,
      jwt: { algorithm: 'RS256' },
      oidc: { issuer: 'https://auth.example.com' },
    };
    config = {
      ...config,
      oidc: (await generateAndLoadKeyPair(config.oidc!)).oidc,
    };

    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config);
    const payload = await verifyToken(token, config);
    expect(payload.sub).toBe('u1');
  });

  test('RS256 token fails HS256 verification', async () => {
    config = {
      ...config,
      jwt: { algorithm: 'RS256' },
      oidc: { issuer: 'https://auth.example.com' },
    };
    config = {
      ...config,
      oidc: (await generateAndLoadKeyPair(config.oidc!)).oidc,
    };

    const token = await signToken({ sub: 'u1', sid: 's1' }, undefined, config);

    // Reset to HS256
    const hs256Config = { ...DEFAULT_AUTH_CONFIG };

    await expect(verifyToken(token, hs256Config)).rejects.toThrow();
  });
});

describe('OIDC discovery endpoints', () => {
  test('/.well-known/openid-configuration returns discovery doc', async () => {
    config = { ...config, oidc: { issuer: 'https://auth.example.com' } };
    config = {
      ...config,
      oidc: (await generateAndLoadKeyPair(config.oidc!)).oidc,
    };
    const app = buildOidcApp();

    const res = await app.request('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe('https://auth.example.com');
    expect(body.jwks_uri).toBe('https://auth.example.com/.well-known/jwks.json');
    expect(body.id_token_signing_alg_values_supported).toContain('RS256');
  });

  test('/.well-known/jwks.json returns 503 when no key loaded', async () => {
    config = { ...config, oidc: { issuer: 'https://auth.example.com' } };
    const app = buildOidcApp();

    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'OIDC signing key is not loaded' });
  });

  test('/.well-known/jwks.json returns public key after loading', async () => {
    config = { ...config, oidc: { issuer: 'https://auth.example.com' } };
    config = {
      ...config,
      oidc: (await generateAndLoadKeyPair(config.oidc!)).oidc,
    };

    const app = buildOidcApp();

    const res = await app.request('/.well-known/jwks.json');
    const body = await res.json();
    expect(body.keys.length).toBe(1);
    expect(body.keys[0].kty).toBe('RSA');
    expect(body.keys[0].use).toBe('sig');
  });

  test('returns 404 when OIDC not configured', async () => {
    const app = buildOidcApp();

    const res = await app.request('/.well-known/openid-configuration');
    expect(res.status).toBe(404);
  });
});
