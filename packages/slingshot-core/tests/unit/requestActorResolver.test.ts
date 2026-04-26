import { describe, expect, test } from 'bun:test';
import { attachContext } from '../../src/context/contextStore';
import { ANONYMOUS_ACTOR, type Actor } from '../../src/identity';
import {
  getRequestActorResolver,
  getRequestActorResolverOrNull,
} from '../../src/requestActorResolver';

const userActor = (id: string): Actor => ({
  ...ANONYMOUS_ACTOR,
  id,
  kind: 'user',
});

/**
 * Create a minimal branded SlingshotContext-like object with just the fields
 * needed by actorResolver. We use attachContext to install the brand symbol,
 * then pass the context directly to the resolver helpers.
 */
function createBrandedContext(
  actorResolver: { resolveActor(req: Request): Promise<Actor> } | null,
) {
  const ctxData = { actorResolver };
  const ctx = ctxData as unknown as Record<string, unknown>;
  const app = {};
  attachContext(app, ctx as never);
  return ctx;
}

describe('getRequestActorResolver', () => {
  test('returns the resolver when one is registered', () => {
    const fakeResolver = {
      resolveActor: async () => userActor('user-123'),
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

  test('resolves actor from the returned resolver', async () => {
    const fakeResolver = {
      resolveActor: async () => userActor('user-456'),
    };
    const ctx = createBrandedContext(fakeResolver);
    const resolver = getRequestActorResolver(ctx);
    const actor = await resolver.resolveActor(new Request('http://localhost/'));
    expect(actor.id).toBe('user-456');
    expect(actor.kind).toBe('user');
  });
});

describe('getRequestActorResolverOrNull', () => {
  test('returns the resolver when one is registered', () => {
    const fakeResolver = {
      resolveActor: async () => userActor('user-789'),
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
      resolveActor: async () => userActor('user-app'),
    };
    const ctxData = { actorResolver: fakeResolver };
    const ctx = ctxData as unknown as Record<string, unknown>;
    const app = {};
    attachContext(app, ctx as never);
    const result = getRequestActorResolver(app);
    expect(result).toBe(fakeResolver);
  });

  test('throws when app has no context attached', () => {
    const plainObj = {};
    expect(() => getRequestActorResolver(plainObj)).toThrow('SlingshotContext not found');
  });
});
