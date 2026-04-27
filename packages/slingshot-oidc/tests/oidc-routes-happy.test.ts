import { beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AuthResolvedConfig } from '@lastshotlabs/slingshot-auth';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { generateAndLoadKeyPair } from '../src/lib/jwks';
import { createOidcRouter } from '../src/routes/oidc';

let config: AuthResolvedConfig;

beforeAll(async () => {
  const base = { issuer: 'https://auth.example.com' };
  const { oidc } = await generateAndLoadKeyPair(base as never);
  config = { oidc: { ...oidc, issuer: 'https://auth.example.com' } } as AuthResolvedConfig;
});

function buildApp(cfg: AuthResolvedConfig) {
  const app = new Hono();
  app.route('/', createOidcRouter(cfg));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 404 | 503);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });
  return app;
}

describe('OIDC discovery endpoint happy path', () => {
  test('returns 200 with a well-formed discovery document', async () => {
    const app = buildApp(config);
    const res = await app.request('/.well-known/openid-configuration');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.issuer).toBe('https://auth.example.com');
    expect(body.jwks_uri).toBe('https://auth.example.com/.well-known/jwks.json');
    expect(body.response_types_supported).toEqual(['code']);
    expect(body.subject_types_supported).toEqual(['public']);
    expect(body.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post']);
    expect(body.claims_supported).toContain('sub');
  });

  test('derives token_endpoint and authorization_endpoint from issuer when not configured', async () => {
    const app = buildApp(config);
    const res = await app.request('/.well-known/openid-configuration');
    const body = await res.json();

    expect(body.token_endpoint).toBe('https://auth.example.com/oauth/token');
    expect(body.authorization_endpoint).toBe('https://auth.example.com/auth/oauth/authorize');
  });

  test('sets Cache-Control: public, max-age=86400', async () => {
    const app = buildApp(config);
    const res = await app.request('/.well-known/openid-configuration');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  test('uses custom tokenEndpoint and authorizationEndpoint when configured', async () => {
    const customConfig = {
      oidc: {
        ...config.oidc,
        tokenEndpoint: 'https://custom.example.com/token',
        authorizationEndpoint: 'https://custom.example.com/authorize',
      },
    } as AuthResolvedConfig;
    const app = buildApp(customConfig);
    const res = await app.request('/.well-known/openid-configuration');
    const body = await res.json();

    expect(body.token_endpoint).toBe('https://custom.example.com/token');
    expect(body.authorization_endpoint).toBe('https://custom.example.com/authorize');
  });

  test('includes custom scopes when configured', async () => {
    const customConfig = {
      oidc: { ...config.oidc, scopes: ['openid', 'email', 'profile'] },
    } as AuthResolvedConfig;
    const app = buildApp(customConfig);
    const res = await app.request('/.well-known/openid-configuration');
    const body = await res.json();

    expect(body.scopes_supported).toEqual(['openid', 'email', 'profile']);
  });
});

describe('JWKS endpoint happy path', () => {
  test('returns 200 with a keys array containing the public signing key', async () => {
    const app = buildApp(config);
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.keys).toBeArray();
    expect(body.keys.length).toBeGreaterThan(0);

    const [key] = body.keys;
    expect(key.kty).toBe('RSA');
    expect(key.alg).toBe('RS256');
    expect(key.use).toBe('sig');
    expect(key.kid).toBeString();
  });

  test('sets Cache-Control: public, max-age=86400', async () => {
    const app = buildApp(config);
    const res = await app.request('/.well-known/jwks.json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });
});
