/**
 * `defineRequestScope` E2E:
 *  - Factory runs lazily on first getRequestScoped, cached for the rest of the request
 *  - Cleanup runs after the response, even on error
 *  - Cleanup runs in LIFO order
 *  - Different requests get different scope values
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { defineRequestScope, getRequestScoped, route } from '@lastshotlabs/slingshot-core';
import { definePackage, domain } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const baseConfig = {
  meta: { name: 'Request Scope Test App' },
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

const teardowns: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of teardowns.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

describe('defineRequestScope', () => {
  test('factory runs lazily and value is cached for the request', async () => {
    let factoryCalls = 0;
    const counter = defineRequestScope({
      name: 'counter',
      factory: () => {
        factoryCalls += 1;
        return { id: factoryCalls };
      },
    });

    const pkg = definePackage({
      name: 'test',
      domains: [
        domain({
          name: 'scoped',
          basePath: '/scoped',
          routes: [
            route.get({
              path: '/twice',
              auth: 'none',
              handler: async ({ request, respond }) => {
                const a = await getRequestScoped(request, counter);
                const b = await getRequestScoped(request, counter);
                return respond.json({ a, b, sameRef: a === b });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      requestScopes: [counter],
      packages: [pkg],
    });
    teardowns.push(result.ctx);

    const res = await result.app.request('/scoped/twice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { a: { id: number }; b: { id: number }; sameRef: boolean };
    expect(body.sameRef).toBe(true);
    expect(body.a.id).toBe(1);
    expect(body.b.id).toBe(1);
    // Factory ran exactly once for the request, despite two getRequestScoped calls.
    expect(factoryCalls).toBe(1);
  });

  test('different requests get different values', async () => {
    let factoryCalls = 0;
    const counter = defineRequestScope({
      name: 'counter',
      factory: () => {
        factoryCalls += 1;
        return { id: factoryCalls };
      },
    });

    const pkg = definePackage({
      name: 'test',
      domains: [
        domain({
          name: 'scoped',
          basePath: '/scoped',
          routes: [
            route.get({
              path: '/value',
              auth: 'none',
              handler: async ({ request, respond }) => {
                const c = await getRequestScoped(request, counter);
                return respond.json({ id: c.id });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      requestScopes: [counter],
      packages: [pkg],
    });
    teardowns.push(result.ctx);

    const res1 = await result.app.request('/scoped/value');
    const res2 = await result.app.request('/scoped/value');
    const body1 = (await res1.json()) as { id: number };
    const body2 = (await res2.json()) as { id: number };
    expect(body1.id).toBe(1);
    expect(body2.id).toBe(2);
    expect(factoryCalls).toBe(2);
  });

  test('cleanup runs after the response when the value was initialized', async () => {
    const events: string[] = [];
    const tx = defineRequestScope({
      name: 'tx',
      factory: () => {
        events.push('factory');
        return { committed: false };
      },
      cleanup: async value => {
        events.push(value.committed ? 'cleanup-committed' : 'cleanup-rolled-back');
      },
    });

    const pkg = definePackage({
      name: 'test',
      domains: [
        domain({
          name: 'scoped',
          basePath: '/scoped',
          routes: [
            route.post({
              path: '/commit',
              auth: 'none',
              handler: async ({ request, respond }) => {
                const t = await getRequestScoped(request, tx);
                t.committed = true;
                events.push('handler-done');
                return respond.json({ ok: true });
              },
            }),
            route.post({
              path: '/skip',
              auth: 'none',
              handler: async ({ respond }) => {
                events.push('handler-skipped');
                return respond.json({ ok: true });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      requestScopes: [tx],
      packages: [pkg],
    });
    teardowns.push(result.ctx);

    // Path that uses the scope → factory + cleanup run
    events.length = 0;
    await result.app.request('/scoped/commit', { method: 'POST' });
    expect(events).toEqual(['factory', 'handler-done', 'cleanup-committed']);

    // Path that doesn't touch the scope → factory + cleanup don't run
    events.length = 0;
    await result.app.request('/scoped/skip', { method: 'POST' });
    expect(events).toEqual(['handler-skipped']);
  });

  test('cleanup runs in LIFO order', async () => {
    const events: string[] = [];
    const a = defineRequestScope({
      name: 'a',
      factory: () => {
        events.push('factory-a');
        return 'a';
      },
      cleanup: () => {
        events.push('cleanup-a');
      },
    });
    const b = defineRequestScope({
      name: 'b',
      factory: () => {
        events.push('factory-b');
        return 'b';
      },
      cleanup: () => {
        events.push('cleanup-b');
      },
    });

    const pkg = definePackage({
      name: 'test',
      domains: [
        domain({
          name: 'scoped',
          basePath: '/scoped',
          routes: [
            route.get({
              path: '/lifo',
              auth: 'none',
              handler: async ({ request, respond }) => {
                await getRequestScoped(request, a);
                await getRequestScoped(request, b);
                return respond.json({ ok: true });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      requestScopes: [a, b],
      packages: [pkg],
    });
    teardowns.push(result.ctx);

    await result.app.request('/scoped/lifo');
    // a is initialized first; cleanup-b runs first (LIFO).
    expect(events).toEqual(['factory-a', 'factory-b', 'cleanup-b', 'cleanup-a']);
  });

  test('getRequestScoped throws when scope is not registered', async () => {
    const unregistered = defineRequestScope({
      name: 'unregistered',
      factory: () => 'value',
    });

    const pkg = definePackage({
      name: 'test',
      domains: [
        domain({
          name: 'scoped',
          basePath: '/scoped',
          routes: [
            route.get({
              path: '/missing',
              auth: 'none',
              handler: async ({ request, respond }) => {
                try {
                  await getRequestScoped(request, unregistered);
                  return respond.json({ ok: true });
                } catch (err) {
                  return respond.json(
                    { error: err instanceof Error ? err.message : String(err) },
                    400,
                  );
                }
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      // No requestScopes registered, so the middleware never installs the store.
      ...baseConfig,
      packages: [pkg],
    });
    teardowns.push(result.ctx);

    const res = await result.app.request('/scoped/missing');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("getRequestScoped('unregistered')");
  });
});
