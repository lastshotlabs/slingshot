import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Hono CORS behaviour via createTestApp (security.cors config)
// ---------------------------------------------------------------------------

describe('CORS — wildcard (*)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({
      security: { cors: '*', rateLimit: { windowMs: 60_000, max: 1000 } },
    });
  });

  it('sets Access-Control-Allow-Origin: * for any origin', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'http://random.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('OPTIONS preflight returns 204', async () => {
    const res = await app.request('/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});

describe('CORS — specific origin allowlist', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp({
      security: {
        cors: ['http://allowed.example.com', 'http://also-allowed.example.com'],
        rateLimit: { windowMs: 60_000, max: 1000 },
      },
    });
  });

  it('reflects the allowed origin in ACAO header', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'http://allowed.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://allowed.example.com');
  });

  it('sets Access-Control-Allow-Credentials: true for allowed origin', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'http://allowed.example.com' },
    });
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('allows second origin in the list', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'http://also-allowed.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://also-allowed.example.com');
  });

  it('does not reflect a non-matching origin in ACAO header', async () => {
    const res = await app.request('/health', {
      headers: { Origin: 'http://evil.example.com' },
    });
    // Hono's cors does not echo back an origin that isn't in the allowlist
    expect(res.headers.get('access-control-allow-origin')).not.toBe('http://evil.example.com');
  });

  it('OPTIONS preflight returns 204', async () => {
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: { Origin: 'http://allowed.example.com' },
    });
    expect(res.status).toBe(204);
  });
});
