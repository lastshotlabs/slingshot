/**
 * Plugin flow E2E tests.
 *
 * Verifies that framework plugin lifecycle phases (setupMiddleware, setupRoutes,
 * setupPost) execute in correct order, that plugin-registered middleware runs
 * on every request, that multiple plugins coexist without interference, and
 * that plugin teardown fires on server stop.
 *
 * Uses createTestHttpServer() with real plugin instances over raw fetch().
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import type { E2EServerHandle } from '../setup-e2e';
import { createTestHttpServer } from '../setup-e2e';

// ---------------------------------------------------------------------------
// Lifecycle ordering
// ---------------------------------------------------------------------------

describe('plugin lifecycle — phase ordering', () => {
  const order: string[] = [];
  let handle: E2EServerHandle;

  const pluginA: SlingshotPlugin = {
    name: 'plugin-a',
    setupMiddleware: async () => {
      order.push('a:middleware');
    },
    setupRoutes: async () => {
      order.push('a:routes');
    },
    setupPost: async () => {
      order.push('a:post');
    },
  };

  const pluginB: SlingshotPlugin = {
    name: 'plugin-b',
    dependencies: ['plugin-a'],
    setupMiddleware: async () => {
      order.push('b:middleware');
    },
    setupRoutes: async () => {
      order.push('b:routes');
    },
    setupPost: async () => {
      order.push('b:post');
    },
  };

  beforeAll(async () => {
    handle = await createTestHttpServer({ plugins: [pluginB, pluginA] }); // intentionally reversed
  });

  afterAll(() => handle.stop());

  test('setupMiddleware runs before setupRoutes (intra-plugin)', () => {
    const aMiddleware = order.indexOf('a:middleware');
    const aRoutes = order.indexOf('a:routes');
    expect(aMiddleware).toBeLessThan(aRoutes);
  });

  test('setupRoutes runs before setupPost (intra-plugin)', () => {
    const aRoutes = order.indexOf('a:routes');
    const aPost = order.indexOf('a:post');
    expect(aRoutes).toBeLessThan(aPost);
  });

  test('dependency (plugin-a) middleware runs before dependent (plugin-b) middleware', () => {
    expect(order.indexOf('a:middleware')).toBeLessThan(order.indexOf('b:middleware'));
  });

  test('dependency (plugin-a) routes runs before dependent (plugin-b) routes', () => {
    expect(order.indexOf('a:routes')).toBeLessThan(order.indexOf('b:routes'));
  });

  test('all six lifecycle calls were made', () => {
    expect(order).toContain('a:middleware');
    expect(order).toContain('a:routes');
    expect(order).toContain('a:post');
    expect(order).toContain('b:middleware');
    expect(order).toContain('b:routes');
    expect(order).toContain('b:post');
  });
});

// ---------------------------------------------------------------------------
// Middleware registered by plugins applies to every request
// ---------------------------------------------------------------------------

describe('plugin lifecycle — middleware applies to requests', () => {
  let handle: E2EServerHandle;
  const requestLog: string[] = [];

  const loggingPlugin: SlingshotPlugin = {
    name: 'logging-plugin',
    setupMiddleware: async ({ app }) => {
      app.use('*', async (c, next) => {
        requestLog.push(c.req.path);
        await next();
      });
    },
  };

  beforeAll(async () => {
    handle = await createTestHttpServer({ plugins: [loggingPlugin] });
  });

  afterAll(() => handle.stop());

  beforeEach(() => {
    requestLog.length = 0;
  });

  test('plugin middleware fires on /health request', async () => {
    await fetch(`${handle.baseUrl}/health`);
    expect(requestLog.some(p => p.includes('health'))).toBe(true);
  });

  test('plugin middleware fires on every successive request', async () => {
    await fetch(`${handle.baseUrl}/health`);
    await fetch(`${handle.baseUrl}/health`);
    expect(requestLog.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Routes registered by plugins are reachable
// ---------------------------------------------------------------------------

describe('plugin lifecycle — routes registered by plugins', () => {
  let handle: E2EServerHandle;

  const routePlugin: SlingshotPlugin = {
    name: 'route-plugin',
    setupRoutes: async ({ app }) => {
      app.get('/plugin-route', c => c.json({ from: 'plugin' }));
    },
  };

  beforeAll(async () => {
    handle = await createTestHttpServer({ plugins: [routePlugin] });
  });

  afterAll(() => handle.stop());

  test('GET /plugin-route returns 200 with expected payload', async () => {
    const res = await fetch(`${handle.baseUrl}/plugin-route`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.from).toBe('plugin');
  });

  test('route not registered by any plugin returns 404', async () => {
    const res = await fetch(`${handle.baseUrl}/non-existent-plugin-route`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Multiple plugins do not interfere with each other
// ---------------------------------------------------------------------------

describe('plugin lifecycle — multiple plugins coexist', () => {
  let handle: E2EServerHandle;

  const pluginOne: SlingshotPlugin = {
    name: 'plugin-one',
    setupRoutes: async ({ app }) => {
      app.get('/plugin-one', c => c.json({ plugin: 1 }));
    },
  };

  const pluginTwo: SlingshotPlugin = {
    name: 'plugin-two',
    setupRoutes: async ({ app }) => {
      app.get('/plugin-two', c => c.json({ plugin: 2 }));
    },
  };

  beforeAll(async () => {
    handle = await createTestHttpServer({ plugins: [pluginOne, pluginTwo] });
  });

  afterAll(() => handle.stop());

  test('plugin-one route returns correct payload', async () => {
    const res = await fetch(`${handle.baseUrl}/plugin-one`);
    const body = (await res.json()) as any;
    expect(body.plugin).toBe(1);
  });

  test('plugin-two route returns correct payload', async () => {
    const res = await fetch(`${handle.baseUrl}/plugin-two`);
    const body = (await res.json()) as any;
    expect(body.plugin).toBe(2);
  });

  test('both plugins are reachable simultaneously', async () => {
    const [r1, r2] = await Promise.all([
      fetch(`${handle.baseUrl}/plugin-one`),
      fetch(`${handle.baseUrl}/plugin-two`),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Plugin teardown fires in reverse setup order
// ---------------------------------------------------------------------------

describe('plugin lifecycle — teardown ordering', () => {
  const teardownOrder: string[] = [];

  const teardownA: SlingshotPlugin = {
    name: 'teardown-a',
    setupPost: async () => {},
    teardown: async () => {
      teardownOrder.push('a');
    },
  };

  const teardownB: SlingshotPlugin = {
    name: 'teardown-b',
    dependencies: ['teardown-a'],
    setupPost: async () => {},
    teardown: async () => {
      teardownOrder.push('b');
    },
  };

  test('teardown fires in reverse order (b before a)', async () => {
    const handle = await createTestHttpServer({ plugins: [teardownA, teardownB] });
    await handle.stop();
    // b was set up after a (dependency order), so b should tear down first
    expect(teardownOrder.indexOf('b')).toBeLessThan(teardownOrder.indexOf('a'));
  });
});

// ---------------------------------------------------------------------------
// setupPost — post-setup initialization
// ---------------------------------------------------------------------------

describe('plugin lifecycle — setupPost phase', () => {
  test('setupPost can register a route available after all routes phases complete', async () => {
    let setupPostCalled = false;

    const postPlugin: SlingshotPlugin = {
      name: 'post-phase-plugin',
      setupPost: async ({ app }) => {
        setupPostCalled = true;
        app.get('/post-route', c => c.json({ phase: 'post' }));
      },
    };

    const handle = await createTestHttpServer({ plugins: [postPlugin] });
    try {
      expect(setupPostCalled).toBe(true);
      const res = await fetch(`${handle.baseUrl}/post-route`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.phase).toBe('post');
    } finally {
      handle.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth plugin is the baseline — verify it wires up correctly
// ---------------------------------------------------------------------------

describe('plugin lifecycle — auth plugin baseline', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer();
  });

  afterAll(() => handle.stop());

  test('POST /auth/register returns 201 with token', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'lifecycle@example.com', password: 'password123' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(typeof body.token).toBe('string');
  });

  test('GET /auth/me with valid token returns 200 with user email', async () => {
    // Register first
    const regRes = await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'me-check@example.com', password: 'password123' }),
    });
    const { token } = (await regRes.json()) as any;

    const meRes = await fetch(`${handle.baseUrl}/auth/me`, {
      headers: { 'x-user-token': token },
    });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as any;
    expect(body.email).toBe('me-check@example.com');
  });

  test('GET /auth/me without token returns 401', async () => {
    const res = await fetch(`${handle.baseUrl}/auth/me`);
    expect(res.status).toBe(401);
  });

  test('POST /auth/login with correct credentials returns token', async () => {
    // Register
    await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login-test@example.com', password: 'mypassword1' }),
    });
    // Login
    const res = await fetch(`${handle.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login-test@example.com', password: 'mypassword1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.token).toBe('string');
  });

  test('POST /auth/login with wrong password returns 401', async () => {
    await fetch(`${handle.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'wrong-pw@example.com', password: 'correct1' }),
    });
    const res = await fetch(`${handle.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'wrong-pw@example.com', password: 'incorrect' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Framework health + metrics endpoints
// ---------------------------------------------------------------------------

describe('plugin lifecycle — built-in framework endpoints', () => {
  let handle: E2EServerHandle;

  beforeAll(async () => {
    handle = await createTestHttpServer();
  });

  afterAll(() => handle.stop());

  test('GET /health returns 200', async () => {
    const res = await fetch(`${handle.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  test('GET /health returns JSON body with status field', async () => {
    const res = await fetch(`${handle.baseUrl}/health`);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty('status');
  });

  test('GET /cached returns 200 (framework cached endpoint)', async () => {
    const res = await fetch(`${handle.baseUrl}/cached`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Plugin middleware ordering relative to framework middleware
// ---------------------------------------------------------------------------

describe('plugin lifecycle — middleware ordering', () => {
  test('plugin-registered middleware receives slingshotCtx (framework ran first)', async () => {
    let hadSlingshotCtx = false;

    const ctxPlugin: SlingshotPlugin = {
      name: 'ctx-checker',
      setupMiddleware: async ({ app }) => {
        app.use('*', async (c, next) => {
          // getSlingshotCtx is available because framework middleware runs before plugins
          try {
            const { getSlingshotCtx } = await import('@lastshotlabs/slingshot-core');
            getSlingshotCtx(c); // throws if not set
            hadSlingshotCtx = true;
          } catch {
            hadSlingshotCtx = false;
          }
          await next();
        });
      },
    };

    const handle = await createTestHttpServer({ plugins: [ctxPlugin] });
    try {
      await fetch(`${handle.baseUrl}/health`);
      expect(hadSlingshotCtx).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
