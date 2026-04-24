import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { getActor, getActorId, getActorTenantId } from '../../src/actorContext';
import type { AppEnv } from '../../src/context';
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
  test('returns an explicit actor from context', () => {
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
  });

  test('returns ANONYMOUS_ACTOR when no actor is set', () => {
    const c = createContext();

    const actor = getActor(c);

    expect(actor).toMatchObject({
      id: null,
      kind: 'anonymous',
      tenantId: null,
      sessionId: null,
    });
    expect(getActorId(c)).toBeNull();
    expect(getActorTenantId(c)).toBeNull();
  });

  test('getActorId returns actor.id for a user actor', () => {
    const actor: Actor = {
      id: 'user-2',
      kind: 'user',
      tenantId: 'tenant-2',
      sessionId: 'sess-2',
      roles: ['editor'],
      claims: {},
    };
    const c = createContext({ actor });

    expect(getActorId(c)).toBe('user-2');
    expect(getActorTenantId(c)).toBe('tenant-2');
  });

  test('getActorTenantId returns null for tenantless actor', () => {
    const actor: Actor = {
      id: 'svc-1',
      kind: 'service-account',
      tenantId: null,
      sessionId: null,
      roles: null,
      claims: {},
    };
    const c = createContext({ actor });

    expect(getActorTenantId(c)).toBeNull();
  });

  test('explicit actor set after context creation is returned by getActor', () => {
    const c = createContext();

    // Initially anonymous
    expect(getActor(c)).toMatchObject({ kind: 'anonymous' });

    // Set actor later (simulating auth middleware)
    const actor: Actor = Object.freeze({
      id: 'late-user',
      kind: 'user' as const,
      tenantId: 'late-tenant',
      sessionId: null,
      roles: null,
      claims: {},
    });
    c.set('actor', actor);

    expect(getActor(c)).toMatchObject({
      id: 'late-user',
      kind: 'user',
      tenantId: 'late-tenant',
    });
  });
});
