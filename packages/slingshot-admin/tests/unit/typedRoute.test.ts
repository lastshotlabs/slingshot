/**
 * Unit tests for admin typedRoute utilities: registerRoute, createTypedRouter.
 *
 * These are thin type-adapter helpers. Tests verify:
 *   - createTypedRouter returns a router with an openapi method
 *   - registerRoute delegates to router.openapi
 */
import { describe, expect, mock, test } from 'bun:test';
import { createTypedRouter, registerRoute } from '../../src/lib/typedRoute';

// ---------------------------------------------------------------------------
// createTypedRouter
// ---------------------------------------------------------------------------

describe('createTypedRouter', () => {
  test('returns an object (router instance)', () => {
    const router = createTypedRouter();
    expect(router).toBeDefined();
    expect(typeof router).toBe('object');
  });

  test('returned router has an openapi method', () => {
    const router = createTypedRouter();
    expect(typeof router.openapi).toBe('function');
  });

  test('returned router has a route method', () => {
    const router = createTypedRouter();
    expect(typeof router.route).toBe('function');
  });

  test('each call returns a new independent router instance', () => {
    const r1 = createTypedRouter();
    const r2 = createTypedRouter();
    expect(r1).not.toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// registerRoute
// ---------------------------------------------------------------------------

describe('registerRoute', () => {
  test('calls router.openapi with the provided route and handler', () => {
    const openapiMock = mock(() => {});
    const router = { openapi: openapiMock } as any;
    const route = { method: 'get', path: '/test' } as any;
    const handler = mock(() => new Response());

    registerRoute(router, route, handler);

    expect(openapiMock).toHaveBeenCalledWith(route, handler);
  });

  test('forwards the return value of router.openapi', () => {
    const returnValue = { chained: true };
    const router = { openapi: mock(() => returnValue) } as any;
    const result = registerRoute(
      router,
      {} as any,
      mock(() => new Response()),
    );
    // Cast to unknown — the mock returns a plain object but the static return type is
    // OpenAPIHono<AdminEnv>. The test is verifying forwarding behaviour, not the static type.
    expect(result as unknown).toEqual(returnValue);
  });

  test('is called exactly once per registerRoute call', () => {
    const openapiMock = mock(() => {});
    const router = { openapi: openapiMock } as any;
    registerRoute(
      router,
      {} as any,
      mock(() => new Response()),
    );
    expect(openapiMock).toHaveBeenCalledTimes(1);
  });
});
