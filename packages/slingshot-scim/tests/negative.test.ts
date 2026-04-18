import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createScimAuth } from '../src/middleware/scimAuth';

function buildApp(runtime: unknown) {
  const app = new Hono();
  app.use('/scim/*', createScimAuth(runtime as never));
  app.get('/scim/v2/Users', c => c.json({ ok: true }));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as 401);
    }
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });
  return app;
}

describe('slingshot-scim negative branches', () => {
  test('fails closed when mounted without configured bearer tokens', async () => {
    const app = buildApp({ config: {} });
    const response = await app.request('/scim/v2/Users');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: '[slingshot-scim] SCIM auth middleware mounted without configured bearer tokens',
    });
  });

  test('returns 401 when the bearer token header is missing', async () => {
    const app = buildApp({
      config: {
        scim: {
          bearerTokens: ['scim-secret'],
        },
      },
    });
    const response = await app.request('/scim/v2/Users');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'SCIM bearer token required' });
  });

  test('returns 401 when the bearer token is invalid', async () => {
    const app = buildApp({
      config: {
        scim: {
          bearerTokens: ['scim-secret'],
        },
      },
    });
    const response = await app.request('/scim/v2/Users', {
      headers: { Authorization: 'Bearer wrong-token' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid SCIM token' });
  });
});
