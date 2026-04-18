import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Default formatter — defaultHook path (inline @hono/zod-openapi validation)
// ---------------------------------------------------------------------------

describe('defaultHook path — default formatter', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: { enabled: false },
      },
    );
  });

  test('returns structured { error, details, requestId } on validation failure', async () => {
    const res = await app.request('/validation/inline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }), // missing age
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details[0]).toHaveProperty('path');
    expect(body.details[0]).toHaveProperty('message');
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  test('details contain field path', async () => {
    const res = await app.request('/validation/inline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // missing both name and age
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const paths = body.details.map((d: { path: string }) => d.path);
    expect(paths).toContain('name');
    expect(paths).toContain('age');
  });
});

// ---------------------------------------------------------------------------
// Default formatter — validate() → onError path
// ---------------------------------------------------------------------------

describe('validate() onError path — default formatter', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {},
      {
        auth: { enabled: false },
      },
    );
  });

  test('returns structured { error, details, requestId } on validation failure', async () => {
    const res = await app.request('/validation/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }), // missing age
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  test('requestId in validate() error matches X-Request-Id response header', async () => {
    const res = await app.request('/validation/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const headerRequestId = res.headers.get('x-request-id');
    if (headerRequestId) {
      expect(body.requestId).toBe(headerRequestId);
    }
  });
});

// ---------------------------------------------------------------------------
// Custom formatter
// ---------------------------------------------------------------------------

describe('custom validation.formatError', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {
        validation: {
          formatError: (issues, requestId) => ({
            customError: true,
            count: issues.length,
            reqId: requestId,
          }),
        },
      },
      {
        auth: { enabled: false },
      },
    );
  });

  test('defaultHook uses custom formatter', async () => {
    const res = await app.request('/validation/inline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.customError).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(body.count).toBeGreaterThan(0);
    expect(typeof body.reqId).toBe('string');
  });

  test('validate() onError uses custom formatter', async () => {
    const res = await app.request('/validation/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.customError).toBe(true);
    expect(typeof body.count).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Throwing custom formatter — falls back to default (not 500)
// ---------------------------------------------------------------------------

describe('throwing formatError falls back to default formatter', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp(
      {
        validation: {
          formatError: () => {
            throw new Error('formatter exploded');
          },
        },
      },
      {
        auth: { enabled: false },
      },
    );
  });

  test('defaultHook falls back to default formatter (not 500)', async () => {
    const res = await app.request('/validation/inline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
  });

  test('validate() onError falls back to default formatter (not 500)', async () => {
    const res = await app.request('/validation/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
  });
});
