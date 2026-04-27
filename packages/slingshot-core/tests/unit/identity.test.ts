import { describe, expect, test } from 'bun:test';
import {
  ANONYMOUS_ACTOR,
  type Actor,
  type IdentityResolverInput,
  createDefaultIdentityResolver,
} from '../../src/identity';

// ---------------------------------------------------------------------------
// ANONYMOUS_ACTOR
// ---------------------------------------------------------------------------

describe('ANONYMOUS_ACTOR', () => {
  test('has the expected shape', () => {
    expect(ANONYMOUS_ACTOR).toEqual({
      id: null,
      kind: 'anonymous',
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    });
  });

  test('is frozen', () => {
    expect(Object.isFrozen(ANONYMOUS_ACTOR)).toBe(true);
  });

  test('claims bag is frozen', () => {
    expect(Object.isFrozen(ANONYMOUS_ACTOR.claims)).toBe(true);
  });

  test('cannot be mutated', () => {
    expect(() => {
      (ANONYMOUS_ACTOR as any).id = 'hacked';
    }).toThrow();
    expect(ANONYMOUS_ACTOR.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createDefaultIdentityResolver — user actor
// ---------------------------------------------------------------------------

describe('createDefaultIdentityResolver', () => {
  const resolver = createDefaultIdentityResolver();

  function input(overrides: Partial<IdentityResolverInput> = {}): IdentityResolverInput {
    return {
      userId: null,
      sessionId: null,
      roles: null,
      serviceAccountId: null,
      apiKeyId: null,
      tenantId: null,
      tokenPayload: null,
      ...overrides,
    };
  }

  describe('user actor', () => {
    test('resolves when userId is set', () => {
      const actor = resolver.resolve(input({ userId: 'user-1' }));
      expect(actor.id).toBe('user-1');
      expect(actor.kind).toBe('user');
    });

    test('carries tenantId through', () => {
      const actor = resolver.resolve(input({ userId: 'u', tenantId: 'org-5' }));
      expect(actor.tenantId).toBe('org-5');
    });

    test('carries sessionId through', () => {
      const actor = resolver.resolve(input({ userId: 'u', sessionId: 'sess-7' }));
      expect(actor.sessionId).toBe('sess-7');
    });

    test('carries roles through', () => {
      const actor = resolver.resolve(input({ userId: 'u', roles: ['admin', 'editor'] }));
      expect(actor.roles).toEqual(['admin', 'editor']);
    });

    test('produces empty claims', () => {
      const actor = resolver.resolve(input({ userId: 'u' }));
      expect(actor.claims).toEqual({});
    });

    test('userId takes priority over apiKeyId', () => {
      const actor = resolver.resolve(input({ userId: 'user-1', apiKeyId: 'client-1' }));
      expect(actor.kind).toBe('user');
      expect(actor.id).toBe('user-1');
    });

    test('userId takes priority over serviceAccountId', () => {
      const actor = resolver.resolve(input({ userId: 'user-1', serviceAccountId: 'svc-1' }));
      expect(actor.kind).toBe('user');
      expect(actor.id).toBe('user-1');
    });

    test('userId takes priority when all three are set', () => {
      const actor = resolver.resolve(
        input({ userId: 'user-1', apiKeyId: 'client-1', serviceAccountId: 'svc-1' }),
      );
      expect(actor.kind).toBe('user');
      expect(actor.id).toBe('user-1');
    });
  });

  // ---------------------------------------------------------------------------
  // api-key actor
  // ---------------------------------------------------------------------------

  describe('api-key actor', () => {
    test('resolves when apiKeyId is set (no userId)', () => {
      const actor = resolver.resolve(input({ apiKeyId: 'key-1' }));
      expect(actor.id).toBe('key-1');
      expect(actor.kind).toBe('api-key');
    });

    test('session is always null for api-key', () => {
      const actor = resolver.resolve(input({ apiKeyId: 'key-1', sessionId: 'sess-ignored' }));
      expect(actor.sessionId).toBeNull();
    });

    test('carries roles', () => {
      const actor = resolver.resolve(input({ apiKeyId: 'key-1', roles: ['reader'] }));
      expect(actor.roles).toEqual(['reader']);
    });

    test('carries tenantId', () => {
      const actor = resolver.resolve(input({ apiKeyId: 'key-1', tenantId: 'org-9' }));
      expect(actor.tenantId).toBe('org-9');
    });

    test('apiKeyId takes priority over serviceAccountId when no userId', () => {
      const actor = resolver.resolve(input({ apiKeyId: 'key-1', serviceAccountId: 'svc-1' }));
      expect(actor.kind).toBe('api-key');
      expect(actor.id).toBe('key-1');
    });
  });

  // ---------------------------------------------------------------------------
  // service-account actor
  // ---------------------------------------------------------------------------

  describe('service-account actor', () => {
    test('resolves when only serviceAccountId is set', () => {
      const actor = resolver.resolve(input({ serviceAccountId: 'svc-1' }));
      expect(actor.id).toBe('svc-1');
      expect(actor.kind).toBe('service-account');
    });

    test('session is always null for service-account', () => {
      const actor = resolver.resolve(
        input({ serviceAccountId: 'svc-1', sessionId: 'sess-ignored' }),
      );
      expect(actor.sessionId).toBeNull();
    });

    test('carries tenantId', () => {
      const actor = resolver.resolve(input({ serviceAccountId: 'svc-1', tenantId: 'tenant-3' }));
      expect(actor.tenantId).toBe('tenant-3');
    });

    test('carries roles', () => {
      const actor = resolver.resolve(input({ serviceAccountId: 'svc-1', roles: ['service'] }));
      expect(actor.roles).toEqual(['service']);
    });
  });

  // ---------------------------------------------------------------------------
  // anonymous actor
  // ---------------------------------------------------------------------------

  describe('anonymous actor', () => {
    test('resolves when no identity fields are set', () => {
      const actor = resolver.resolve(input());
      expect(actor.id).toBeNull();
      expect(actor.kind).toBe('anonymous');
      expect(actor.sessionId).toBeNull();
      expect(actor.roles).toBeNull();
      expect(actor.claims).toEqual({});
    });

    test('carries tenantId even for anonymous', () => {
      const actor = resolver.resolve(input({ tenantId: 'pub-tenant' }));
      expect(actor.kind).toBe('anonymous');
      expect(actor.tenantId).toBe('pub-tenant');
    });

    test('returns null tenantId when not set', () => {
      const actor = resolver.resolve(input());
      expect(actor.tenantId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('empty-string userId is treated as falsy (anonymous)', () => {
      const actor = resolver.resolve(input({ userId: '' }));
      expect(actor.kind).toBe('anonymous');
      expect(actor.id).toBeNull();
    });

    test('empty-string apiKeyId is treated as falsy (anonymous)', () => {
      const actor = resolver.resolve(input({ apiKeyId: '' }));
      expect(actor.kind).toBe('anonymous');
    });

    test('empty-string serviceAccountId is treated as falsy (anonymous)', () => {
      const actor = resolver.resolve(input({ serviceAccountId: '' }));
      expect(actor.kind).toBe('anonymous');
    });

    test('tokenPayload is ignored by the default resolver', () => {
      const actor = resolver.resolve(input({ tokenPayload: { sub: 'tok-user', scope: 'admin' } }));
      expect(actor.kind).toBe('anonymous');
    });

    test('null roles stay null', () => {
      const actor = resolver.resolve(input({ userId: 'u', roles: null }));
      expect(actor.roles).toBeNull();
    });

    test('empty roles array is preserved', () => {
      const actor = resolver.resolve(input({ userId: 'u', roles: [] }));
      expect(actor.roles).toEqual([]);
    });

    test('each call returns a new object', () => {
      const a = resolver.resolve(input({ userId: 'u' }));
      const b = resolver.resolve(input({ userId: 'u' }));
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    test('resolver instances are independent', () => {
      const r1 = createDefaultIdentityResolver();
      const r2 = createDefaultIdentityResolver();
      expect(r1).not.toBe(r2);
      const a1 = r1.resolve(input({ userId: 'u' }));
      const a2 = r2.resolve(input({ userId: 'u' }));
      expect(a1).toEqual(a2);
    });
  });
});
