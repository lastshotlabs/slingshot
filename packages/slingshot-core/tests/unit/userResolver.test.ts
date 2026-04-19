import { describe, expect, test } from 'bun:test';
import { getUserResolver, getUserResolverOrNull } from '../../src/userResolver';
import { attachContext } from '../../src/context/contextStore';

/**
 * Create a minimal branded SlingshotContext-like object with just the fields
 * needed by userResolver. We use attachContext to install the brand symbol,
 * then pass the context directly to the resolver helpers.
 */
function createBrandedContext(userResolver: { resolveUserId(req: Request): Promise<string | null> } | null) {
  // Build a minimal context object that satisfies the shape resolveContext checks.
  const ctx = { userResolver } as Record<string, unknown>;
  // We need a carrier (app) to brand the context through attachContext.
  const app = {};
  attachContext(app, ctx as never);
  // After attachContext, ctx now carries the brand symbol and can be recognized
  // by isContextObject, so resolveContext(ctx) will return ctx directly.
  return ctx;
}

describe('getUserResolver', () => {
  test('returns the resolver when one is registered', () => {
    const fakeResolver = {
      resolveUserId: async (_req: Request) => 'user-123',
    };
    const ctx = createBrandedContext(fakeResolver);
    const result = getUserResolver(ctx);
    expect(result).toBe(fakeResolver);
  });

  test('throws when no UserResolver is registered (null)', () => {
    const ctx = createBrandedContext(null);
    expect(() => getUserResolver(ctx)).toThrow(
      'No UserResolver registered for this app instance.',
    );
  });

  test('resolves user from the returned resolver', async () => {
    const fakeResolver = {
      resolveUserId: async (_req: Request) => 'user-456',
    };
    const ctx = createBrandedContext(fakeResolver);
    const resolver = getUserResolver(ctx);
    const userId = await resolver.resolveUserId(new Request('http://localhost/'));
    expect(userId).toBe('user-456');
  });
});

describe('getUserResolverOrNull', () => {
  test('returns the resolver when one is registered', () => {
    const fakeResolver = {
      resolveUserId: async (_req: Request) => 'user-789',
    };
    const ctx = createBrandedContext(fakeResolver);
    const result = getUserResolverOrNull(ctx);
    expect(result).toBe(fakeResolver);
  });

  test('returns null when no UserResolver is registered', () => {
    const ctx = createBrandedContext(null);
    const result = getUserResolverOrNull(ctx);
    expect(result).toBeNull();
  });
});

describe('getUserResolver with app carrier', () => {
  test('resolves from an app object that has a context attached', () => {
    const fakeResolver = {
      resolveUserId: async (_req: Request) => 'user-app',
    };
    const ctx = { userResolver: fakeResolver } as Record<string, unknown>;
    const app = {};
    attachContext(app, ctx as never);
    // Pass the app (not the context) — resolveContext will call getContext(app)
    const result = getUserResolver(app);
    expect(result).toBe(fakeResolver);
  });

  test('throws when app has no context attached', () => {
    const plainObj = {};
    expect(() => getUserResolver(plainObj)).toThrow(
      'SlingshotContext not found',
    );
  });
});
