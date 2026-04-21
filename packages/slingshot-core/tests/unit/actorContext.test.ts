import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import type { AppEnv } from '../../src/context';
import { getActor, getActorId, getActorTenantId } from '../../src/actorContext';
import type { Actor } from '../../src/identity';

function createContext(values: Record<string, unknown> = {}): Context<AppEnv> {
  const store = new Map<string, unknown>(Object.entries(values));
  return {
    get(key: string) {
      return store.get(key) ?? null;
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
  } as unknown as Context<AppEnv>;
}

describe('actorContext helpers', () => {
  test('returns an explicit actor from context and freezes it', () => {
    const actor: Actor = {
      id: 'user-1',
      kind: 'user',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      roles: ['admin'],
      claims: { orgId: 'org-1' },
    };
    const c = createContext({ actor });

    const resolved = getActor(c);

    expect(resolved).toMatchObject(actor);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.claims)).toBe(true);
    expect(Object.isFrozen(resolved.roles!)).toBe(true);
  });

  test('resolves a user actor from legacy auth variables when actor is absent', () => {
    const c = createContext({
      authUserId: 'user-2',
      sessionId: 'sess-2',
      tenantId: 'tenant-2',
      roles: ['editor'],
    });

    const actor = getActor(c);

    expect(actor).toMatchObject({
      id: 'user-2',
      kind: 'user',
      tenantId: 'tenant-2',
      sessionId: 'sess-2',
      roles: ['editor'],
    });
    expect(getActorId(c)).toBe('user-2');
    expect(getActorTenantId(c)).toBe('tenant-2');
    expect(c.get('actor')).toBe(actor);
  });

  test('resolves a service-account actor from authClientId', () => {
    const c = createContext({
      authClientId: 'svc-1',
      tenantId: 'tenant-svc',
    });

    expect(getActor(c)).toMatchObject({
      id: 'svc-1',
      kind: 'service-account',
      tenantId: 'tenant-svc',
      sessionId: null,
    });
  });

  test('resolves an anonymous actor when no identity inputs are present', () => {
    const c = createContext();

    expect(getActor(c)).toMatchObject({
      id: null,
      kind: 'anonymous',
      tenantId: null,
      sessionId: null,
    });
    expect(getActorId(c)).toBeNull();
    expect(getActorTenantId(c)).toBeNull();
  });

  test('refreshes a stale anonymous actor when auth variables appear later', () => {
    const c = createContext({
      actor: {
        id: null,
        kind: 'anonymous',
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: {},
      } satisfies Actor,
    });

    c.set('authUserId', 'late-user');
    c.set('tenantId', 'late-tenant');

    expect(getActor(c)).toMatchObject({
      id: 'late-user',
      kind: 'user',
      tenantId: 'late-tenant',
    });
  });
});
