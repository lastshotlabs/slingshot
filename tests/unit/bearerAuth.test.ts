import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp(
    {},
    {
      security: {
        bearerAuth: true,
        bearerTokens: ['test-bearer-token'],
      },
      auth: { enabled: false },
    },
  );
});

describe('bearerAuth middleware', () => {
  test('valid bearer token passes', async () => {
    const res = await app.request('/cached', {
      headers: { Authorization: 'Bearer test-bearer-token' },
    });
    expect(res.status).toBe(200);
  });

  test('invalid token returns 401', async () => {
    const res = await app.request('/cached', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('missing Authorization header returns 401', async () => {
    const res = await app.request('/cached');
    expect(res.status).toBe(401);
  });

  test('malformed header without Bearer prefix returns 401', async () => {
    const res = await app.request('/cached', {
      headers: { Authorization: 'Token test-bearer-token' },
    });
    expect(res.status).toBe(401);
  });
});
