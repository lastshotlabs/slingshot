import { describe, expect, test } from 'bun:test';
import { type HandlerMeta, resolveActor } from '../../src/handler';
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
    requestTenantId: null,
    correlationId: 'req-1',
    ip: null,
    ...overrides,
  };
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

    test('resolves to the explicit actor unchanged', () => {
      const meta = baseMeta({
        actor: userActor,
        requestTenantId: 'different-tenant',
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
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('actor field set to ANONYMOUS_ACTOR returns it directly', () => {
      const result = resolveActor(baseMeta({ actor: ANONYMOUS_ACTOR }));
      expect(result).toBe(ANONYMOUS_ACTOR);
    });

    test('returns actor directly — resolveActor is a plain accessor', () => {
      const actor = resolveActor(baseMeta({ actor: userActor }));
      expect(actor).toBe(userActor);
    });
  });
});
