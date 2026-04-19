import { describe, expect, test } from 'bun:test';
import { attachContext, getContextOrNull } from '../../src/context/contextStore';
import { getRouteAuth, getRouteAuthOrNull } from '../../src/routeAuth';

function createBrandedContext(overrides: Record<string, unknown> = {}) {
  const app = { use: () => {} };
  const ctx = {
    config: {},
    persistence: {},
    routeAuth: null,
    userResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    pluginState: new Map(),
    ...overrides,
  };

  if (!getContextOrNull(app)) {
    attachContext(app, ctx as never);
  }

  return { ctx, app };
}

function createMiddleware() {
  return (async (_c: unknown, next: () => Promise<void>) => {
    await next();
  }) as never;
}

describe('getRouteAuth', () => {
  test('returns the registry when one is registered', () => {
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const { ctx } = createBrandedContext({ routeAuth });

    expect(getRouteAuth(ctx as never)).toBe(routeAuth);
  });

  test('throws with descriptive message when no registry is registered', () => {
    const { ctx } = createBrandedContext({ routeAuth: null });

    expect(() => getRouteAuth(ctx as never)).toThrow(
      'No RouteAuthRegistry registered for this app instance.',
    );
    expect(() => getRouteAuth(ctx as never)).toThrow(
      'The auth plugin must be registered when using auth: "userAuth"',
    );
  });

  test('resolves via app object (ContextCarrier branch)', () => {
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const { app } = createBrandedContext({ routeAuth });

    expect(getRouteAuth(app as never)).toBe(routeAuth);
  });
});

describe('getRouteAuthOrNull', () => {
  test('returns the registry when one is registered', () => {
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const { ctx } = createBrandedContext({ routeAuth });

    expect(getRouteAuthOrNull(ctx as never)).toBe(routeAuth);
  });

  test('returns null when no registry is registered', () => {
    const { ctx } = createBrandedContext({ routeAuth: null });

    expect(getRouteAuthOrNull(ctx as never)).toBeNull();
  });
});
