import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createOidcRouter } from '../src/routes/oidc';

function buildApp(config: unknown) {
  const app = new Hono();
  app.route('/', createOidcRouter(config as never));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as 404 | 503);
    }
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });
  return app;
}

describe('slingshot-oidc negative branches', () => {
  test('returns 404 when OIDC is not configured', async () => {
    const app = buildApp({});
    const response = await app.request('/.well-known/openid-configuration');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'OIDC not configured' });
  });

  test('returns 503 when OIDC signing keys are not loaded', async () => {
    const app = buildApp({
      oidc: {
        issuer: 'https://issuer.example.com',
      },
    });
    const response = await app.request('/.well-known/jwks.json');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'OIDC signing key is not loaded' });
  });
});
