import { afterEach, describe, expect, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { COOKIE_TOKEN, createRouter } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { createTestApp } from '../setup';

const baseConfig = {
  meta: { name: 'Assembly Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const createdApps: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdApps.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

describe('app assembly', () => {
  test('applies CORS before tenant resolution failures', async () => {
    const result = await createApp({
      ...baseConfig,
      security: {
        ...baseConfig.security,
        cors: ['https://allowed.example.com'],
      },
      tenancy: { resolution: 'header' },
    });
    createdApps.push(result.ctx);

    const response = await result.app.request('/tenant-probe', {
      method: 'POST',
      headers: { Origin: 'https://allowed.example.com' },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
    expect(await response.json()).toMatchObject({ error: 'Tenant ID required' });
  });

  test('merges plugin public paths into tenancy exemptions and context publicPaths', async () => {
    const publicPlugin: SlingshotPlugin = {
      name: 'public-plugin',
      publicPaths: ['/public-hook'],
      setupRoutes({ app }) {
        const router = createRouter();
        router.get('/public-hook', c => c.json({ ok: true }));
        app.route('/', router);
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [publicPlugin],
      tenancy: { resolution: 'header' },
    });
    createdApps.push(result.ctx);

    const response = await result.app.request('/public-hook');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(result.ctx.publicPaths.has('/public-hook')).toBe(true);
    expect('add' in (result.ctx.publicPaths as object)).toBe(false);
    expect('delete' in (result.ctx.publicPaths as object)).toBe(false);
  });

  test('merges plugin public paths and csrf exemptions into auth csrf protection', async () => {
    const hookPlugin: SlingshotPlugin = {
      name: 'hook-plugin',
      publicPaths: ['/hooks/public'],
      csrfExemptPaths: ['/hooks/exempt'],
      setupRoutes({ app }) {
        const router = createRouter();
        router.post('/hooks/public', c => c.json({ ok: true, kind: 'public' }));
        router.post('/hooks/exempt', c => c.json({ ok: true, kind: 'exempt' }));
        app.route('/', router);
      },
    };

    const app = await createTestApp(
      {
        plugins: [hookPlugin],
      },
      {
        security: {
          csrf: { enabled: true },
        },
      },
    );
    createdApps.push((app as unknown as { ctx: { destroy(): Promise<void> } }).ctx);

    const cookie = `${COOKIE_TOKEN}=session-token`;

    const protectedResponse = await app.request('/protected/action', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(protectedResponse.status).toBe(403);

    const exemptResponse = await app.request('/hooks/exempt', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(exemptResponse.status).toBe(200);
    expect(await exemptResponse.json()).toEqual({ ok: true, kind: 'exempt' });

    const publicResponse = await app.request('/hooks/public', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toEqual({ ok: true, kind: 'public' });
  });
});
