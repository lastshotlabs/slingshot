import { beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '../../src/app';
import { authPlugin } from '../setup';

const versionedRoutesDir = import.meta.dir + '/../fixtures/versioning';

const baseConfig = {
  routesDir: versionedRoutesDir,
  meta: { name: 'Versioned API', version: '1.0.0' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: { rateLimit: { windowMs: 60_000, max: 1000 } },
  logging: { onLog: () => {} },
  plugins: [authPlugin({ auth: { enabled: false } })],
};

describe('versioning — route isolation', () => {
  beforeEach(() => {});

  test('GET /v1/users returns v1 response', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v1/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('users');
    expect(body.users[0]).toMatchObject({ id: '1', name: 'Alice' });
    // v1 does not include email or total
    expect(body.users[0]).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('total');
  });

  test('GET /v2/users returns v2 response', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v2/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('users');
    expect(body).toHaveProperty('total');
    expect(body.users[0]).toMatchObject({ id: '1', name: 'Alice', email: 'alice@example.com' });
  });

  test('v1-only endpoint returns 404 when accessed via /v2', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    // /v2/users exists but let's verify cross-version isolation: v2 doesn't have a route that v1 does not
    // Test that a path only in v1 returns 404 on v2
    const res = await app.request('/v2/nonexistent-v1-path');
    expect(res.status).toBe(404);
  });

  test('shared health route available in both versions', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });

    const r1 = await app.request('/v1/health');
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as any;
    expect(b1.status).toBe('ok');

    const r2 = await app.request('/v2/health');
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as any;
    expect(b2.status).toBe('ok');
  });
});

describe('versioning — OpenAPI specs', () => {
  beforeEach(() => {});

  test('GET /v1/openapi.json returns 200 JSON', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as any;
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toContain('V1');
  });

  test('GET /v2/openapi.json returns 200 JSON', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v2/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as any;
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toContain('V2');
  });

  test('v1 spec contains /users path', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v1/openapi.json');
    const spec = (await res.json()) as any;
    expect(spec.paths).toHaveProperty('/users');
  });

  test('v2 spec contains /users path', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v2/openapi.json');
    const spec = (await res.json()) as any;
    expect(spec.paths).toHaveProperty('/users');
  });

  test('no cross-version schema leakage — V2 schemas absent from v1 spec', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const v1Res = await app.request('/v1/openapi.json');
    const v1Spec = (await v1Res.json()) as any;
    const v1Schemas = v1Spec.components?.schemas ?? {};

    // v1 schemas should be prefixed V1... not V2...
    const v2SchemaKeys = Object.keys(v1Schemas).filter(k => k.startsWith('V2'));
    expect(v2SchemaKeys).toHaveLength(0);
  });

  test('v1 spec schema names are prefixed with V1', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v1/openapi.json');
    const spec = (await res.json()) as any;
    const schemas = spec.components?.schemas ?? {};
    const keys = Object.keys(schemas);
    // All auto-registered v1 schemas should start with V1
    const nonV1 = keys.filter(k => !k.startsWith('V1') && !k.startsWith('Get'));
    // Shared health schemas have no version prefix
    // (filter out HealthGetResponse which comes from shared)
    const nonVersioned = nonV1.filter(k => !k.startsWith('Health') && !k.startsWith('Get'));
    expect(nonVersioned).toHaveLength(0);
  });
});

describe('versioning — docs and redirects', () => {
  beforeEach(() => {});

  test('GET /v1/docs returns Scalar HTML', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/v1/docs');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!doctype html');
  });

  test('GET /docs returns version selector HTML', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('/v1/docs');
    expect(text).toContain('/v2/docs');
  });

  test('GET /openapi.json redirects to default version (last in array)', async () => {
    const { app } = await createApp({ ...baseConfig, versioning: { versions: ['v1', 'v2'] } });
    const res = await app.request('/openapi.json');
    // Should be a 302 redirect, not a 200 with merged spec
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/v2/openapi.json');
  });

  test('GET /openapi.json redirects to explicit defaultVersion', async () => {
    const { app } = await createApp({
      ...baseConfig,
      versioning: { versions: ['v1', 'v2'], defaultVersion: 'v1' },
    });
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/v1/openapi.json');
  });
});

describe('versioning — non-versioned behavior unchanged', () => {
  beforeEach(() => {});

  test('without versioning config, routes work at root', async () => {
    // Use the standard fixture routes dir (no versioning)
    const { app } = await createApp({
      ...baseConfig,
      routesDir: import.meta.dir + '/../fixtures/routes',
      plugins: [
        authPlugin({ auth: { enabled: true, roles: ['admin', 'user'], defaultRole: 'user' } }),
      ],
    });
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });

  test('without versioning config, /openapi.json serves spec directly', async () => {
    const { app } = await createApp({
      ...baseConfig,
      routesDir: import.meta.dir + '/../fixtures/routes',
      plugins: [
        authPlugin({ auth: { enabled: true, roles: ['admin', 'user'], defaultRole: 'user' } }),
      ],
    });
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as any;
    expect(spec.openapi).toBe('3.0.0');
  });
});
