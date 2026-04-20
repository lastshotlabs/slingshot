import { describe, expect, test } from 'bun:test';
import { resolveActor, type HandlerMeta } from '../../src/handler';
import { ANONYMOUS_ACTOR, type Actor } from '../../src/identity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userActor: Actor = {
  id: 'user-1',
  kind: 'user',
  tenantId: 'tenant-1',
  sessionId: 'sess-1',
  roles: ['admin'],
  claims: { orgId: 'org-42' },
};

const apiKeyActor: Actor = {
  id: 'key-abc',
  kind: 'api-key',
  tenantId: 'tenant-2',
  sessionId: null,
  roles: ['reader'],
  claims: {},
};

const serviceActor: Actor = {
  id: 'svc-xyz',
  kind: 'service-account',
  tenantId: null,
  sessionId: null,
  roles: null,
  claims: {},
};

const systemActor: Actor = {
  id: 'system',
  kind: 'system',
  tenantId: null,
  sessionId: null,
  roles: null,
  claims: {},
};

function baseMeta(overrides: Partial<HandlerMeta> = {}): HandlerMeta {
  return {
    requestId: 'req-1',
    actor: ANONYMOUS_ACTOR,
    tenantId: null,
    authUserId: null,
    correlationId: 'req-1',
    ip: null,
    ...overrides,
  };
}

/** Build a meta WITHOUT the actor field — simulates legacy external callers. */
function legacyMeta(
  overrides: Partial<Omit<HandlerMeta, 'actor'>> = {},
): HandlerMeta {
  const meta = {
    requestId: 'req-1',
    tenantId: null as string | null,
    authUserId: null as string | null,
    correlationId: 'req-1',
    ip: null,
    ...overrides,
  };
  // Intentionally omit actor to test the fallback path.
  return meta as unknown as HandlerMeta;
}

// ---------------------------------------------------------------------------
// resolveActor with explicit actor
// ---------------------------------------------------------------------------

describe('resolveActor', () => {
  describe('with explicit actor on meta', () => {
    test('returns the actor directly for a user', () => {
      expect(resolveActor(baseMeta({ actor: userActor }))).toBe(userActor);
    });

    test('returns the actor directly for an api-key', () => {
      expect(resolveActor(baseMeta({ actor: apiKeyActor }))).toBe(apiKeyActor);
    });

    test('returns the actor directly for a service-account', () => {
      expect(resolveActor(baseMeta({ actor: serviceActor }))).toBe(serviceActor);
    });

    test('returns the actor directly for a system actor', () => {
      expect(resolveActor(baseMeta({ actor: systemActor }))).toBe(systemActor);
    });

    test('returns the actor directly for anonymous', () => {
      expect(resolveActor(baseMeta({ actor: ANONYMOUS_ACTOR }))).toBe(ANONYMOUS_ACTOR);
    });

    test('actor takes precedence over conflicting legacy fields', () => {
      const meta = baseMeta({
        actor: userActor,
        authUserId: 'different-user',
        tenantId: 'different-tenant',
      });
      const resolved = resolveActor(meta);
      expect(resolved).toBe(userActor);
      expect(resolved.id).toBe('user-1');
      expect(resolved.tenantId).toBe('tenant-1');
    });

    test('actor with custom claims is returned as-is', () => {
      const actor: Actor = {
        id: 'u',
        kind: 'user',
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: { orgId: 'org-42', department: 'eng', nested: { deep: true } },
      };
      expect(resolveActor(baseMeta({ actor }))).toBe(actor);
      expect(resolveActor(baseMeta({ actor })).claims).toEqual({
        orgId: 'org-42',
        department: 'eng',
        nested: { deep: true },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // resolveActor with legacy fallback (no actor field)
  // ---------------------------------------------------------------------------

  describe('legacy fallback (no actor field)', () => {
    test('builds user actor from authUserId', () => {
      const actor = resolveActor(legacyMeta({ authUserId: 'user-1', tenantId: 'tenant-1' }));
      expect(actor.id).toBe('user-1');
      expect(actor.kind).toBe('user');
      expect(actor.tenantId).toBe('tenant-1');
      expect(actor.sessionId).toBeNull();
      expect(actor.claims).toEqual({});
    });

    test('builds user actor with roles', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: 'user-1', roles: ['admin', 'editor'] }),
      );
      expect(actor.roles).toEqual(['admin', 'editor']);
    });

    test('builds api-key actor from bearerClientId', () => {
      const actor = resolveActor(legacyMeta({ bearerClientId: 'key-1' }));
      expect(actor.id).toBe('key-1');
      expect(actor.kind).toBe('api-key');
      expect(actor.sessionId).toBeNull();
    });

    test('builds api-key actor with tenantId', () => {
      const actor = resolveActor(
        legacyMeta({ bearerClientId: 'key-1', tenantId: 'org-3' }),
      );
      expect(actor.tenantId).toBe('org-3');
    });

    test('builds service-account actor from authClientId', () => {
      const actor = resolveActor(legacyMeta({ authClientId: 'svc-1' }));
      expect(actor.id).toBe('svc-1');
      expect(actor.kind).toBe('service-account');
      expect(actor.sessionId).toBeNull();
    });

    test('builds anonymous when no identity fields set', () => {
      const actor = resolveActor(legacyMeta());
      expect(actor.id).toBeNull();
      expect(actor.kind).toBe('anonymous');
    });

    test('anonymous preserves tenantId', () => {
      const actor = resolveActor(legacyMeta({ tenantId: 'pub-tenant' }));
      expect(actor.kind).toBe('anonymous');
      expect(actor.tenantId).toBe('pub-tenant');
    });

    test('authUserId takes priority over bearerClientId in legacy', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: 'user-1', bearerClientId: 'key-1' }),
      );
      expect(actor.kind).toBe('user');
      expect(actor.id).toBe('user-1');
    });

    test('authUserId takes priority over authClientId in legacy', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: 'user-1', authClientId: 'svc-1' }),
      );
      expect(actor.kind).toBe('user');
    });

    test('bearerClientId takes priority over authClientId in legacy', () => {
      const actor = resolveActor(
        legacyMeta({ bearerClientId: 'key-1', authClientId: 'svc-1' }),
      );
      expect(actor.kind).toBe('api-key');
      expect(actor.id).toBe('key-1');
    });

    test('all three set — authUserId wins in legacy', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: 'user-1', bearerClientId: 'key-1', authClientId: 'svc-1' }),
      );
      expect(actor.kind).toBe('user');
      expect(actor.id).toBe('user-1');
    });

    test('null authUserId falls through to bearerClientId', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: null, bearerClientId: 'key-1' }),
      );
      expect(actor.kind).toBe('api-key');
    });

    test('null authUserId and null bearerClientId falls through to authClientId', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: null, bearerClientId: null, authClientId: 'svc-1' }),
      );
      expect(actor.kind).toBe('service-account');
    });

    test('all null — anonymous', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: null, bearerClientId: null, authClientId: null }),
      );
      expect(actor.kind).toBe('anonymous');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('actor field set to ANONYMOUS_ACTOR returns it directly', () => {
      const result = resolveActor(baseMeta({ actor: ANONYMOUS_ACTOR }));
      expect(result).toBe(ANONYMOUS_ACTOR);
    });

    test('meta with undefined actor field triggers legacy fallback', () => {
      const meta = {
        requestId: 'req-1',
        actor: undefined as unknown as Actor,
        tenantId: 'tenant-1',
        authUserId: 'user-1',
        correlationId: 'req-1',
        ip: null,
      } as HandlerMeta;
      const actor = resolveActor(meta);
      // undefined is falsy, so it goes through buildActorFromLegacy
      expect(actor.id).toBe('user-1');
      expect(actor.kind).toBe('user');
    });

    test('meta with null actor field triggers legacy fallback', () => {
      const meta = {
        requestId: 'req-1',
        actor: null as unknown as Actor,
        tenantId: null,
        authUserId: 'user-2',
        correlationId: 'req-1',
        ip: null,
      } as HandlerMeta;
      const actor = resolveActor(meta);
      expect(actor.id).toBe('user-2');
      expect(actor.kind).toBe('user');
    });

    test('legacy meta with empty-string authUserId falls through', () => {
      const meta = {
        requestId: 'req-1',
        tenantId: null,
        authUserId: '',
        correlationId: 'req-1',
        ip: null,
      } as unknown as HandlerMeta;
      const actor = resolveActor(meta);
      // Empty string is falsy — should not produce a 'user' actor.
      expect(actor.kind).toBe('anonymous');
    });

    test('legacy meta roles are carried through', () => {
      const actor = resolveActor(
        legacyMeta({ authUserId: 'u', roles: ['r1', 'r2'] }),
      );
      expect(actor.roles).toEqual(['r1', 'r2']);
    });

    test('legacy meta with undefined roles gives null', () => {
      const actor = resolveActor(legacyMeta({ authUserId: 'u' }));
      expect(actor.roles).toBeNull();
    });

    test('legacy meta with empty roles array preserves it', () => {
      const actor = resolveActor(legacyMeta({ authUserId: 'u', roles: [] }));
      expect(actor.roles).toEqual([]);
    });

    test('legacy fallback always produces empty claims', () => {
      const actor = resolveActor(legacyMeta({ authUserId: 'u' }));
      expect(actor.claims).toEqual({});
    });
  });
});
