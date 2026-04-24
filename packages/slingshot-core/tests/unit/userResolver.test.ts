import { describe, expect, test } from 'bun:test';
import { attachContext } from '../../src/context/contextStore';
import {
  getRequestActorResolver,
  getRequestActorResolverOrNull,
} from '../../src/requestActorResolver';

/**
 * Create a minimal branded SlingshotContext-like object with just the fields
 * needed by actorResolver. We use attachContext to install the brand symbol,
 * then pass the context directly to the resolver helpers.
 */
function createBrandedContext(
  actorResolver: { resolveActorId(req: Request): Promise<string | null> } | null,
) {
  // Build a minimal context object that satisfies the shape resolveContext checks.
  const ctxData = { actorResolver };
  const ctx = ctxData as unknown as Record<string, unknown>;
  // We need a carrier (app) to brand the context through attachContext.
  const app = {};
  attachContext(app, ctx as never);
  // After attachContext, ctx now carries the brand symbol and can be recognized
  // by isContextObject, so resolveContext(ctx) will return ctx directly.
  return ctx;
}

describe('getRequestActorResolver', () => {
  test('returns the resolver when one is registered', () => {
    const fakeResolver = {
      resolveActorId: async () => 'user-123',
    };
    const ctx = createBrandedContext(fakeResolver);
    const result = getRequestActorResolver(ctx);
    expect(result).toBe(fakeResolver);
  });

  test('throws when no RequestActorResolver is registered (null)', () => {
    const ctx = createBrandedContext(null);
    expect(() => getRequestActorResolver(ctx)).toThrow(
      'No RequestActorResolver registered for this app instance.',
    );
  });

  test('resolves user from the returned resolver', async () => {
    const fakeResolver = {
      resolveActorId: async () => 'user-456',
    };
    const ctx = createBrandedContext(fakeResolver);
    const resolver = getRequestActorResolver(ctx);
    const userId = await resolver.resolveActorId(new Request('http://localhost/'));
    expect(userId).toBe('user-456');
  });
});

describe('getRequestActorResolverOrNull', () => {
  test('returns the resolver when one is registered', () => {
    const fakeResolver = {
      resolveActorId: async () => 'user-789',
    };
    const ctx = createBrandedContext(fakeResolver);
    const result = getRequestActorResolverOrNull(ctx);
    expect(result).toBe(fakeResolver);
  });

  test('returns null when no RequestActorResolver is registered', () => {
    const ctx = createBrandedContext(null);
    const result = getRequestActorResolverOrNull(ctx);
    expect(result).toBeNull();
  });
});

describe('getRequestActorResolver with app carrier', () => {
  test('resolves from an app object that has a context attached', () => {
    const fakeResolver = {
      resolveActorId: async () => 'user-app',
    };
    const ctxData = { actorResolver: fakeResolver };
    const ctx = ctxData as unknown as Record<string, unknown>;
    const app = {};
    attachContext(app, ctx as never);
    // Pass the app (not the context) — resolveContext will call getContext(app)
    const result = getRequestActorResolver(app);
    expect(result).toBe(fakeResolver);
  });

  test('throws when app has no context attached', () => {
    const plainObj = {};
    expect(() => getRequestActorResolver(plainObj)).toThrow('SlingshotContext not found');
  });
});
