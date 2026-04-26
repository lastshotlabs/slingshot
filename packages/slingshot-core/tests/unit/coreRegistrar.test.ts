import { describe, expect, test } from 'bun:test';
import { createCoreRegistrar } from '../../src/coreRegistrar';
import { ANONYMOUS_ACTOR } from '../../src/identity';

function asNever<T>(v: T): never {
  return v as never;
}

function createMiddleware() {
  const fn = async (_c: unknown, next: () => Promise<void>) => {
    await next();
  };
  return fn as never;
}

describe('createCoreRegistrar', () => {
  test('drain returns nulls for unregistered dependencies', () => {
    const { drain } = createCoreRegistrar();
    const snapshot = drain();

    expect(snapshot.routeAuth).toBeNull();
    expect(snapshot.actorResolver).toBeNull();
    expect(snapshot.rateLimitAdapter).toBeNull();
    expect(snapshot.fingerprintBuilder).toBeNull();
    expect(snapshot.cacheAdapters.size).toBe(0);
    expect(snapshot.emailTemplates.size).toBe(0);
  });

  test('registrar methods populate snapshot values', () => {
    const { registrar, drain } = createCoreRegistrar();

    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const actorResolver = {
      async resolveActor() {
        return { ...ANONYMOUS_ACTOR, id: 'user-1', kind: 'user' as const };
      },
    };
    const rateLimitAdapter = {
      async trackAttempt(): Promise<boolean> {
        return false;
      },
    };
    const fingerprintBuilder = {
      async buildFingerprint(): Promise<string> {
        return 'fp';
      },
    };

    registrar.setRouteAuth(routeAuth);
    registrar.setRequestActorResolver(actorResolver);
    registrar.setRateLimitAdapter(rateLimitAdapter);
    registrar.setFingerprintBuilder(fingerprintBuilder);

    const snapshot = drain();

    expect(snapshot.routeAuth).toBe(routeAuth);
    expect(snapshot.actorResolver).toBe(actorResolver);
    expect(snapshot.rateLimitAdapter).toBe(rateLimitAdapter);
    expect(snapshot.fingerprintBuilder).toBe(fingerprintBuilder);
  });

  test('registrar is frozen — properties cannot be reassigned', () => {
    const { registrar } = createCoreRegistrar();
    expect(Object.isFrozen(registrar)).toBe(true);
  });

  test('all setter methods throw after drain (sealed)', () => {
    const { registrar, drain } = createCoreRegistrar();
    drain();

    expect(() => registrar.setRouteAuth(asNever({}))).toThrow(
      'CoreRegistrar is finalized; setRouteAuth() cannot be called after drain().',
    );
    expect(() => registrar.setRequestActorResolver(asNever({}))).toThrow(
      'CoreRegistrar is finalized; setRequestActorResolver() cannot be called after drain().',
    );
    expect(() => registrar.setRateLimitAdapter(asNever({}))).toThrow(
      'CoreRegistrar is finalized; setRateLimitAdapter() cannot be called after drain().',
    );
    expect(() => registrar.setFingerprintBuilder(asNever({}))).toThrow(
      'CoreRegistrar is finalized; setFingerprintBuilder() cannot be called after drain().',
    );
    expect(() => registrar.addCacheAdapter('memory' as never, asNever({}))).toThrow(
      'CoreRegistrar is finalized; addCacheAdapter() cannot be called after drain().',
    );
    expect(() => registrar.addEmailTemplates(asNever({}))).toThrow(
      'CoreRegistrar is finalized; addEmailTemplates() cannot be called after drain().',
    );
  });

  test('addCacheAdapter stores adapters by store name', () => {
    const { registrar, drain } = createCoreRegistrar();
    const memAdapter = asNever({ name: 'memory' });
    const redisAdapter = asNever({ name: 'redis' });

    registrar.addCacheAdapter('memory' as never, memAdapter);
    registrar.addCacheAdapter('redis' as never, redisAdapter);

    const snapshot = drain();
    expect(snapshot.cacheAdapters.get('memory' as never)).toBe(memAdapter);
    expect(snapshot.cacheAdapters.get('redis' as never)).toBe(redisAdapter);
    expect(snapshot.cacheAdapters.size).toBe(2);
  });

  test('addEmailTemplates merges multiple template sets', () => {
    const { registrar, drain } = createCoreRegistrar();

    registrar.addEmailTemplates(
      asNever({
        welcome: { subject: 'Welcome', html: '<p>Welcome</p>' },
      }),
    );
    registrar.addEmailTemplates(
      asNever({
        reset: { subject: 'Reset', html: '<p>Reset</p>' },
      }),
    );

    const snapshot = drain();
    expect(snapshot.emailTemplates.size).toBe(2);
    expect(snapshot.emailTemplates.get('welcome')).toEqual({
      subject: 'Welcome',
      html: '<p>Welcome</p>',
    });
    expect(snapshot.emailTemplates.get('reset')).toEqual({
      subject: 'Reset',
      html: '<p>Reset</p>',
    });
  });

  test('drain returns independent snapshots of maps', () => {
    const { registrar, drain } = createCoreRegistrar();
    const adapter = asNever({ name: 'memory' });

    registrar.addCacheAdapter('memory' as never, adapter);

    const first = drain();
    // Mutating the first snapshot's map should not affect future drain() calls
    first.cacheAdapters.set('redis' as never, asNever({}));

    const second = drain();
    expect(second.cacheAdapters.has('redis' as never)).toBe(false);
    expect(second.cacheAdapters.get('memory' as never)).toBe(adapter);
  });

  test('drain can be called multiple times safely', () => {
    const { registrar, drain } = createCoreRegistrar();
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };

    registrar.setRouteAuth(routeAuth);

    const first = drain();
    const second = drain();

    expect(first.routeAuth).toBe(routeAuth);
    expect(second.routeAuth).toBe(routeAuth);
    // They should be different object references
    expect(first).not.toBe(second);
  });
});
