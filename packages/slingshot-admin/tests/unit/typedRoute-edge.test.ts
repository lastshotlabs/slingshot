/**
 * Edge-case coverage for admin typedRoute utilities.
 *
 * Builds on the core typedRoute tests in typedRoute.test.ts.
 * Covers handler error propagation, route validation edge cases,
 * empty route definitions, and chaining behavior.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createTypedRouter, registerRoute } from '../../src/lib/typedRoute';

// ---------------------------------------------------------------------------
// createTypedRouter edge cases
// ---------------------------------------------------------------------------

describe('createTypedRouter edge cases', () => {
  test('router can be used for route() sub-mounting', () => {
    const router = createTypedRouter();
    expect(typeof router.route).toBe('function');
  });

  test('chaining registerRoute returns the router', () => {
    const router = createTypedRouter();
    const route = { method: 'get', path: '/test' } as any;
    const handler = mock(() => new Response());
    const result = registerRoute(router, route, handler);
    expect(result).toBeDefined();
  });

  test('registerRoute with no path in route still delegates to openapi', () => {
    const openapiMock = mock(() => ({}));
    const router = { openapi: openapiMock } as any;
    const route = { method: 'post' } as any;
    const handler = mock(() => new Response());

    registerRoute(router, route, handler);
    expect(openapiMock).toHaveBeenCalledWith(route, handler);
  });

  test('registerRoute with empty route object still delegates', () => {
    const openapiMock = mock(() => ({}));
    const router = { openapi: openapiMock } as any;
    const handler = mock(() => new Response());

    registerRoute(router, {} as any, handler);
    expect(openapiMock).toHaveBeenCalled();
  });

  test('registerRoute with null route throws naturally from openapi', () => {
    const openapiMock = mock(() => {
      throw new TypeError('Cannot read properties of null');
    });
    const router = { openapi: openapiMock } as any;
    expect(() => registerRoute(router, null as any, mock(() => new Response()))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handler behavior edge cases
// ---------------------------------------------------------------------------

describe('handler behavior edge cases', () => {
  test('handler that throws is not caught by registerRoute', () => {
    const router = createTypedRouter();
    const route = { method: 'get', path: '/error' } as any;
    const throwingHandler = mock(() => {
      throw new Error('handler crashed');
    });
    // registerRoute just delegates to router.openapi — it doesn't catch handler errors
    expect(() => registerRoute(router, route, throwingHandler)).not.toThrow();
    // The handler was registered, not executed — the throw would happen at request time
    expect(throwingHandler).not.toHaveBeenCalled();
  });

  test('multiple registerRoute calls accumulate on the same router', () => {
    const router = createTypedRouter();
    const openapiSpy = mock((_route: unknown, _handler: unknown) => ({}));
    const testRouter = { openapi: openapiSpy } as any;

    registerRoute(testRouter, { method: 'get', path: '/a' } as any, mock(() => new Response()));
    registerRoute(testRouter, { method: 'post', path: '/b' } as any, mock(() => new Response()));
    registerRoute(testRouter, { method: 'delete', path: '/c' } as any, mock(() => new Response()));

    expect(openapiSpy).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Type-coercion-like edge cases (URL / param handling)
// ---------------------------------------------------------------------------

describe('typedRoute type-coercion edge cases', () => {
  test('createTypedRouter returns independent router per call', () => {
    const r1 = createTypedRouter();
    const r2 = createTypedRouter();
    // Each should have its own openapi function object
    expect(r1.openapi).not.toBe(r2.openapi);
  });

  test('router has use method from Hono base', () => {
    const router = createTypedRouter();
    expect(typeof router.use).toBe('function');
  });

  test('router supports onError handler', () => {
    const router = createTypedRouter();
    expect(typeof router.onError).toBe('function');
  });

  test('router supports notFound handler', () => {
    const router = createTypedRouter();
    expect(typeof router.notFound).toBe('function');
  });
});
