import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import type { AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { createAuditLogProvider } from '../../src/framework/auditLog';
import type { AuditLogMiddlewareOptions } from '../../src/framework/middleware/auditLog';
import { auditLog } from '../../src/framework/middleware/auditLog';
import { authHeader, createTestApp } from '../setup';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createAuditedApp(
  options?: Omit<AuditLogMiddlewareOptions, 'store'>,
): Promise<{ app: OpenAPIHono<any>; provider: AuditLogProvider }> {
  const provider = createAuditLogProvider({ store: 'memory' });
  const app = await createTestApp({
    middleware: [auditLog({ store: 'memory', provider, ...options })],
  });
  return { app, provider };
}

async function registerAndGetToken(app: OpenAPIHono<any>, email = 'u@example.com') {
  const res = await app.request('/auth/register', json({ email, password: 'password123' }));
  return (await res.json()) as { token: string; userId: string };
}

describe('auditLog middleware — basic capture', () => {
  test('logs method, path, and status for a GET request', async () => {
    const { app, provider } = await createAuditedApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const { items } = await provider.getLogs({ path: '/health' });
    expect(items.length).toBeGreaterThanOrEqual(1);
    const entry = items.find(e => e.path === '/health');
    expect(entry?.method).toBe('GET');
    expect(entry?.status).toBe(200);
  });

  test('logs POST with 201 status', async () => {
    const { app, provider } = await createAuditedApp();
    await app.request(
      '/auth/register',
      json({ email: 'log-test@example.com', password: 'password123' }),
    );

    const { items } = await provider.getLogs({ path: '/auth/register' });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].method).toBe('POST');
    expect(items[0].status).toBe(201);
  });

  test('captures an audit entry for an authenticated request', async () => {
    const { app, provider } = await createAuditedApp();
    const { token } = await registerAndGetToken(app, 'audit-auth@example.com');

    await app.request('/auth/me', { headers: authHeader(token) });

    const { items } = await provider.getLogs({ path: '/auth/me' });
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('unauthenticated request logs null userId', async () => {
    const { app, provider } = await createAuditedApp();
    await app.request('/health');

    const { items } = await provider.getLogs({ path: '/health' });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].userId).toBeNull();
  });
});

describe('auditLog middleware — exclusions', () => {
  test('exclude.methods skips logging for excluded method', async () => {
    const { app, provider } = await createAuditedApp({ exclude: { methods: ['GET'] } });
    await app.request('/health');
    const { items: excluded } = await provider.getLogs({ path: '/health' });
    expect(excluded.length).toBe(0);
  });

  test('POST is still logged when only GET is excluded', async () => {
    const { app, provider } = await createAuditedApp({ exclude: { methods: ['GET'] } });
    await app.request(
      '/auth/register',
      json({ email: 'excl@example.com', password: 'password123' }),
    );
    const { items } = await provider.getLogs({ path: '/auth/register' });
    expect(items.length).toBe(1);
  });

  test('exclude.paths with string exact match skips logging', async () => {
    const { app, provider } = await createAuditedApp({ exclude: { paths: ['/health'] } });
    await app.request('/health');
    const { items } = await provider.getLogs({ path: '/health' });
    expect(items.length).toBe(0);
  });

  test('exclude.paths with RegExp matches correctly', async () => {
    const { app, provider } = await createAuditedApp({ exclude: { paths: [/^\/auth\//] } });
    await app.request(
      '/auth/register',
      json({ email: 're-excl@example.com', password: 'password123' }),
    );
    const { items } = await provider.getLogs({ path: '/auth/register' });
    expect(items.length).toBe(0);
  });
});

describe('auditLog middleware — onEntry hook', () => {
  test('hook can enrich entry', async () => {
    const { app, provider } = await createAuditedApp({
      onEntry: entry => ({
        ...entry,
        action: 'health-check',
        resource: 'System',
        resourceId: 'main',
        meta: { enriched: true },
      }),
    });

    await app.request('/health');

    const { items } = await provider.getLogs({ path: '/health' });
    expect(items.length).toBeGreaterThanOrEqual(1);
    const entry = items.find(e => e.path === '/health')!;
    expect(entry.action).toBe('health-check');
    expect(entry.resource).toBe('System');
    expect(entry.resourceId).toBe('main');
    expect(entry.meta?.enriched).toBe(true);
  });

  test('error in onEntry hook does not affect response status', async () => {
    const { app } = await createAuditedApp({
      onEntry: () => {
        throw new Error('hook failure');
      },
    });

    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('entry is still written even when onEntry throws', async () => {
    const { app, provider } = await createAuditedApp({
      onEntry: () => {
        throw new Error('hook failure');
      },
    });

    await app.request('/health');

    const { items: hookItems } = await provider.getLogs({ path: '/health' });
    expect(hookItems.length).toBeGreaterThanOrEqual(1);
  });
});
