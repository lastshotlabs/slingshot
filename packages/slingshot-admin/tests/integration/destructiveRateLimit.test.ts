import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryRateLimitStore } from '../../src/lib/rateLimitStore';
import type { AdminRateLimitStore } from '../../src/lib/rateLimitStore';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';

const BASE_USER = {
  id: 'user-1',
  tenantId: 'tenant-a',
  email: 'alice@example.com',
  displayName: 'Alice',
  provider: 'memory' as const,
  status: 'active' as const,
};

function buildApp(opts: {
  rateLimitStore?: AdminRateLimitStore;
  destructiveRateLimit?: { max?: number; windowMs?: number };
}) {
  const managedUserProvider = createMemoryManagedUserProvider();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', {
      subject: 'actor-admin',
      provider: 'memory',
      tenantId: 'tenant-a',
    });
    await next();
  });

  app.route(
    '/',
    createAdminRouter({
      managedUserProvider,
      bus: createInProcessAdapter(),
      evaluator: { can: async () => true },
      rateLimitStore: opts.rateLimitStore,
      destructiveRateLimit: opts.destructiveRateLimit,
    }),
  );

  return { app, managedUserProvider };
}

describe('destructive rate limit — pluggable store', () => {
  test('memory store enforces the configured max within a window', async () => {
    const store = createMemoryRateLimitStore();
    const { app, managedUserProvider } = buildApp({
      rateLimitStore: store,
      destructiveRateLimit: { max: 1, windowMs: 60_000 },
    });
    managedUserProvider.seedUser(BASE_USER);

    const first = await app.request('/users/user-1/suspend', { method: 'POST' });
    const second = await app.request('/users/user-1/suspend', { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
  });

  test('store contract receives the action key in the hit() invocation', async () => {
    const calls: Array<{ key: string; limit: number; windowMs: number }> = [];
    const wrapped: AdminRateLimitStore = {
      async hit(key, opts) {
        calls.push({ key, ...opts });
        return { count: 1, exceeded: false, resetAt: Date.now() + opts.windowMs };
      },
    };
    const { app, managedUserProvider } = buildApp({
      rateLimitStore: wrapped,
      destructiveRateLimit: { max: 5, windowMs: 30_000 },
    });
    managedUserProvider.seedUser(BASE_USER);

    await app.request('/users/user-1/suspend', { method: 'POST' });

    expect(calls).toHaveLength(1);
    expect(calls[0].key).toContain('admin.user.suspend');
    expect(calls[0].limit).toBe(5);
    expect(calls[0].windowMs).toBe(30_000);
  });

  test('default store (no injection) still rate limits — same semantics as before', async () => {
    const { app, managedUserProvider } = buildApp({
      destructiveRateLimit: { max: 1, windowMs: 60_000 },
    });
    managedUserProvider.seedUser(BASE_USER);

    const first = await app.request('/users/user-1/suspend', { method: 'POST' });
    const second = await app.request('/users/user-1/suspend', { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  test('store error fails open — request proceeds', async () => {
    const erroring: AdminRateLimitStore = {
      async hit() {
        throw new Error('store unreachable');
      },
    };
    const { app, managedUserProvider } = buildApp({
      rateLimitStore: erroring,
      destructiveRateLimit: { max: 1, windowMs: 60_000 },
    });
    managedUserProvider.seedUser(BASE_USER);

    const errorSpy = console.error;
    let captured = false;
    console.error = () => {
      captured = true;
    };
    try {
      const res = await app.request('/users/user-1/suspend', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(captured).toBe(true);
    } finally {
      console.error = errorSpy;
    }
  });
});
