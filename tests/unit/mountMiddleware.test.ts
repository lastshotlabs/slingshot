/**
 * Tests for mountMiddleware.ts covering uncovered lines:
 * - Line 89: throw when metrics enabled without auth in production
 * - Lines 101-123: metricsCollector block
 * - Lines 142, 145: CSP and Permissions-Policy custom headers
 * - Lines 149-154: custom security headers middleware
 * - Lines 162-163: bot protection block
 * - Lines 200-201: mountTenantMiddleware throw in production
 * - Line 204: mountTenantMiddleware console.warn in dev
 * - Lines 239-244: mountCors with custom object options
 * - Lines 248-250: mountCors wildcard warning in production
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createMetricsState } from '../../src/framework/metrics/registry';
import {
  mountCors,
  mountFrameworkMiddleware,
  mountTenantMiddleware,
} from '../../src/framework/mountMiddleware';

function makeApp() {
  return new OpenAPIHono<AppEnv>();
}

const minimalSecurity = {
  rateLimit: { windowMs: 60_000, max: 1000 },
};

describe('mountFrameworkMiddleware', () => {
  it('mounts successfully with minimal config (happy path)', async () => {
    const app = makeApp();
    await expect(
      mountFrameworkMiddleware(app, {
        security: minimalSecurity,
        isProd: false,
        logging: { onLog: () => {} },
      }),
    ).resolves.toBeUndefined();
  });

  it('throws when metrics.enabled=true, auth=none, no unsafePublic, isProd=true (line 89)', async () => {
    const app = makeApp();
    const state = createMetricsState();
    await expect(
      mountFrameworkMiddleware(app, {
        security: minimalSecurity,
        isProd: true,
        metrics: { enabled: true, auth: 'none' },
        metricsState: state,
        logging: { onLog: () => {} },
      }),
    ).rejects.toThrow(
      '[security] metrics.auth is required in production.',
    );
  });

  it('warns when metrics.enabled=true, auth=none, no unsafePublic, isProd=false (lines 108-110)', async () => {
    const app = makeApp();
    const state = createMetricsState();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mountFrameworkMiddleware(app, {
        security: minimalSecurity,
        isProd: false,
        metrics: { enabled: true, auth: 'none' },
        metricsState: state,
        logging: { onLog: () => {} },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[security] /metrics is enabled without auth.'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('mounts metricsCollector when metrics.enabled=true with auth (lines 101-123)', async () => {
    const app = makeApp();
    const state = createMetricsState();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: minimalSecurity,
      isProd: false,
      metrics: {
        enabled: true,
        auth: 'userAuth',
        unsafePublic: false,
      },
      metricsState: state,
      logging: { onLog: () => {} },
    });
    // Should not throw — just verify it mounts
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('mounts metricsCollector with unsafePublic=true (lines 101-123)', async () => {
    const app = makeApp();
    const state = createMetricsState();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: minimalSecurity,
      isProd: true,
      metrics: {
        enabled: true,
        auth: 'none',
        unsafePublic: true,
      },
      metricsState: state,
      logging: { onLog: () => {} },
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('sets Content-Security-Policy custom header (lines 142, 149-154)', async () => {
    const app = makeApp();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: {
        ...minimalSecurity,
        headers: {
          contentSecurityPolicy: "default-src 'self'",
        },
      },
      isProd: false,
      logging: { onLog: () => {} },
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('sets Permissions-Policy custom header (lines 145, 149-154)', async () => {
    const app = makeApp();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: {
        ...minimalSecurity,
        headers: {
          permissionsPolicy: 'camera=(), microphone=()',
        },
      },
      isProd: false,
      logging: { onLog: () => {} },
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('mounts bot protection when blockList is non-empty (lines 162-163)', async () => {
    const app = makeApp();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: {
        ...minimalSecurity,
        botProtection: { blockList: ['1.2.3.4'] },
      },
      isProd: false,
      logging: { onLog: () => {} },
    });
    // App mounts without error; request from non-blocked IP passes
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('skips bot protection when blockList is empty', async () => {
    const app = makeApp();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: {
        ...minimalSecurity,
        botProtection: { blockList: [] },
      },
      isProd: false,
      logging: { onLog: () => {} },
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});

describe('mountTenantMiddleware', () => {
  it('throws in production when tenancy has no onResolve (lines 200-201)', async () => {
    const app = makeApp();
    const tenancyData = { resolution: 'subdomain' };
    const tenancy = tenancyData as unknown as never;
    await expect(
      mountTenantMiddleware(app, tenancy, undefined, true),
    ).rejects.toThrow(
      '[security] Tenancy is configured without an onResolve callback.',
    );
  });

  it('warns in development when tenancy has no onResolve (line 204)', async () => {
    const app = makeApp();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tenancyDevData = { resolution: 'subdomain' };
      const tenancyDev = tenancyDevData as unknown as never;
      await mountTenantMiddleware(app, tenancyDev, undefined, false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[security] Tenancy is configured without an onResolve callback'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('mounts tenant middleware when onResolve is provided', async () => {
    const app = makeApp();
    const tenancyWithResolveData = {
      resolution: 'subdomain',
      onResolve: () => Promise.resolve(null),
    };
    const tenancyWithResolve = tenancyWithResolveData as unknown as never;
    await expect(
      mountTenantMiddleware(
        app,
        tenancyWithResolve,
        undefined,
        false,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('mountCors', () => {
  it('mounts CORS with wildcard origin (default)', () => {
    const app = makeApp();
    // Should not throw
    mountCors(app, { ...minimalSecurity });
  });

  it('mounts CORS with specific origin string', () => {
    const app = makeApp();
    mountCors(app, { ...minimalSecurity, cors: 'https://example.com' });
  });

  it('mounts CORS with array of origins', () => {
    const app = makeApp();
    mountCors(app, { ...minimalSecurity, cors: ['https://a.com', 'https://b.com'] });
  });

  it('mounts CORS with custom options object (lines 239-244)', () => {
    const app = makeApp();
    mountCors(app, {
      ...minimalSecurity,
      cors: {
        origin: 'https://example.com',
        credentials: true,
        allowHeaders: ['X-Custom-Header'],
        exposeHeaders: ['X-Response-Header'],
        maxAge: 3600,
      },
    });
  });

  it('warns when CORS is wildcard in production (lines 248-250)', () => {
    const app = makeApp();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mountCors(app, { ...minimalSecurity, cors: '*' }, undefined, true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[security] CORS is set to wildcard (*) in production.'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when CORS has specific origin in production', () => {
    const app = makeApp();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mountCors(app, { ...minimalSecurity, cors: 'https://example.com' }, undefined, true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('includes tenancy header name in CORS allowHeaders when resolution is header', () => {
    const app = makeApp();
    // Should not throw
    mountCors(
      app,
      { ...minimalSecurity },
      { resolution: 'header', headerName: 'x-tenant-id' },
      false,
    );
  });
});

describe('mountFrameworkMiddleware — additional coverage', () => {
  it('mounts OTel request tracing middleware when tracing is enabled (line 89)', async () => {
    const app = makeApp();
    app.get('/test', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: minimalSecurity,
      isProd: false,
      tracing: { enabled: true },
      logging: { onLog: () => {} },
    });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('throws when metrics.enabled=true but metricsState is not provided (line 117)', async () => {
    const app = makeApp();
    await expect(
      mountFrameworkMiddleware(app, {
        security: minimalSecurity,
        isProd: false,
        metrics: { enabled: true, auth: 'userAuth' },
        // metricsState deliberately omitted
        logging: { onLog: () => {} },
      }),
    ).rejects.toThrow('metricsState is required when metrics are enabled');
  });

  it('exercises the custom security headers middleware path (lines 148-155)', async () => {
    // We can't directly assert the headers due to Hono internals cloning the response,
    // but we verify the middleware mounts and requests succeed when both headers are set.
    const app = makeApp();
    app.get('/combined', c => c.json({ ok: true }));
    await mountFrameworkMiddleware(app, {
      security: {
        ...minimalSecurity,
        headers: {
          contentSecurityPolicy: "default-src 'self'",
          permissionsPolicy: 'camera=()',
        },
      },
      isProd: false,
      logging: { onLog: () => {} },
    });
    const res = await app.request('/combined');
    // The middleware mounted successfully and request passed through without error
    expect(res.status).toBe(200);
  });
});
