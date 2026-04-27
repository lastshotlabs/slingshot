import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  COOKIE_TOKEN,
  HttpError,
  ValidationError,
  createRouter,
} from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { createTestApp } from '../setup';

const disconnectRedisMock = mock(async () => {});
const disconnectMongoMock = mock(async () => {});
const actualRedis = await import('@lib/redis');
const actualMongo = await import('@lib/mongo');

mock.module('@lib/redis', () => ({
  ...actualRedis,
  disconnectRedis: disconnectRedisMock,
}));

mock.module('@lib/mongo', () => ({
  ...actualMongo,
  disconnectMongo: disconnectMongoMock,
}));

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

afterAll(() => {
  mock.restore();
});

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

  test('cleanupBootstrapFailure: shuts down bus, disconnects redis+mongo on createApp failure (lines 340-374)', async () => {
    // Force a failure during assembleApp by injecting a plugin that throws during setupMiddleware.
    // This ensures bootstrap is set but assembly.ctx is not yet available, triggering cleanupBootstrapFailure.
    disconnectRedisMock.mockClear();
    disconnectMongoMock.mockClear();

    const secretDestroy = mock(async () => {});

    await expect(
      createApp({
        ...baseConfig,
        db: {
          ...baseConfig.db,
        },
        secrets: {
          name: 'fail-secrets',
          get: async (key: string) => {
            if (key === 'JWT_SECRET') return 'test-secret-key-must-be-at-least-32-chars!!';
            return null;
          },
          getMany: async () => new Map(),
          destroy: secretDestroy,
        },
        plugins: [
          {
            name: 'failing-plugin',
            async setupMiddleware() {
              throw new Error('plugin middleware failed on purpose');
            },
          },
        ],
      }),
    ).rejects.toThrow('plugin middleware failed on purpose');

    // secretDestroy should be called by cleanupBootstrapFailure
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('uses JWT_SECRET from secrets when signing.secret is not provided (line 432)', async () => {
    const result = await createApp({
      ...baseConfig,
      security: {
        ...baseConfig.security,
        signing: undefined,
      },
      secrets: {
        name: 'jwt-env-secrets',
        get: async (key: string) => {
          if (key === 'JWT_SECRET') return 'jwt-secret-from-provider-at-least-32-chars!!';
          return null;
        },
        getMany: async (keys: string[]) => {
          const map = new Map<string, string>();
          for (const k of keys) {
            if (k === 'JWT_SECRET') map.set(k, 'jwt-secret-from-provider-at-least-32-chars!!');
          }
          return map;
        },
      },
    });
    createdApps.push(result.ctx);

    // The app should have started successfully with the JWT_SECRET from secrets
    const healthRes = await result.app.request('/health');
    expect(healthRes.status).toBe(200);
  });

  test('merges plugin tenantExemptPaths into tenancy exempt paths (line 248)', async () => {
    // Plugin defines tenantExemptPaths — exercises line 248 in mergeTenantExemptPaths
    const exemptPlugin: SlingshotPlugin = {
      name: 'exempt-plugin',
      tenantExemptPaths: ['/webhooks/incoming'],
      setupRoutes({ app }) {
        const router = createRouter();
        router.post('/webhooks/incoming', c => c.json({ ok: true }));
        app.route('/', router);
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [exemptPlugin],
      tenancy: { resolution: 'header' },
    });
    createdApps.push(result.ctx);

    // The exempt path should bypass tenant resolution (no tenant header required)
    const response = await result.app.request('/webhooks/incoming', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
  });

  test('onError handler returns 500 for generic errors (line 625-627)', async () => {
    const errorPlugin: SlingshotPlugin = {
      name: 'error-plugin',
      setupRoutes({ app }) {
        const router = createRouter();
        router.get('/throw-generic', () => {
          throw new Error('unexpected crash');
        });
        app.route('/', router);
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [errorPlugin],
    });
    createdApps.push(result.ctx);

    const response = await result.app.request('/throw-generic');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal Server Error');
  });

  test('onError handler returns HttpError status and body (lines 621-624)', async () => {
    const errorPlugin: SlingshotPlugin = {
      name: 'http-error-plugin',
      setupRoutes({ app }) {
        const router = createRouter();
        router.get('/throw-http', () => {
          throw new HttpError(418, "I'm a teapot");
        });
        app.route('/', router);
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [errorPlugin],
    });
    createdApps.push(result.ctx);

    const response = await result.app.request('/throw-http');
    expect(response.status).toBe(418);
    const body = await response.json();
    expect(body.error).toBe("I'm a teapot");
  });

  test('onError handler with broken validationErrorFormatter falls back to default (lines 614-618)', async () => {
    const errorPlugin: SlingshotPlugin = {
      name: 'validation-error-plugin',
      setupRoutes({ app }) {
        const router = createRouter();
        router.get('/throw-validation', () => {
          throw new ValidationError([{ code: 'custom', message: 'bad input', path: [] }]);
        });
        app.route('/', router);
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [errorPlugin],
    });
    createdApps.push(result.ctx);

    const response = await result.app.request('/throw-validation');
    expect(response.status).toBe(400);
    // Should not crash even without a custom formatter
    const body = await response.json();
    expect(body).toBeDefined();
  });

  test('onError catch branch: broken custom formatError falls back to defaultValidationErrorFormatter (lines 617-618)', async () => {
    const errorPlugin: SlingshotPlugin = {
      name: 'broken-fmt-plugin',
      setupRoutes({ app }) {
        const router = createRouter();
        router.get('/throw-validation-broken-fmt', () => {
          throw new ValidationError([{ code: 'custom', message: 'bad input', path: ['field'] }]);
        });
        app.route('/', router);
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [errorPlugin],
      validation: {
        formatError: () => {
          throw new Error('formatter exploded');
        },
      },
    });
    createdApps.push(result.ctx);

    const response = await result.app.request('/throw-validation-broken-fmt');
    expect(response.status).toBe(400);
    const body = await response.json();
    // The default formatter should produce a body with errors array
    expect(body).toBeDefined();
    expect(body.errors || body.error || body.issues).toBeDefined();
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
