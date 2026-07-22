import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Actor, AppEnv } from '@lastshotlabs/slingshot-core';
import type { RouteAuthResult } from '../../src/routing/evaluateRouteAuth';
import { evaluateRouteAuth } from '../../src/routing/evaluateRouteAuth';

function actor(overrides: Partial<Actor>): Actor {
  return Object.freeze({
    id: null,
    kind: 'anonymous' as const,
    tenantId: null,
    sessionId: null,
    roles: null,
    claims: Object.freeze({}),
    ...overrides,
  });
}

const parentRecord = { orgId: 'tenant-a' };
const parentAdapter = { getById: async () => parentRecord };
const operationConfig = {
  permission: {
    requires: 'post:read',
    parentAuth: { idParam: 'orgId', tenantField: 'orgId' },
  },
};

async function runParentAuthCheck(actorValue: Actor): Promise<RouteAuthResult> {
  const app = new Hono<AppEnv>();
  let authResult!: RouteAuthResult;

  app.use('*', async (c, next) => {
    c.set('actor', actorValue);
    await next();
  });

  app.get('/orgs/:orgId/posts', async c => {
    authResult = await evaluateRouteAuth(c, operationConfig, { parentAdapter });
    return c.json({ authorized: authResult.authorized });
  });

  await app.request('/orgs/tenant-a/posts');
  return authResult;
}

describe('evaluateRouteAuth — parentAuth tenant checks', () => {
  test('global service-account (tenantId=null, kind=service-account) bypasses tenant check', async () => {
    const result = await runParentAuthCheck(
      actor({ id: 'svc-1', kind: 'service-account', tenantId: null }),
    );
    expect(result.authorized).toBe(true);
  });

  test('anonymous actor with tenantId=null is blocked by parentAuth tenant check', async () => {
    const result = await runParentAuthCheck(actor({ kind: 'anonymous', tenantId: null }));
    expect(result.authorized).toBe(false);
  });

  test('tenant-scoped user matching parent tenant passes', async () => {
    const result = await runParentAuthCheck(
      actor({ id: 'user-1', kind: 'user', tenantId: 'tenant-a' }),
    );
    expect(result.authorized).toBe(true);
  });

  test('tenant-scoped user with mismatching tenant is blocked', async () => {
    const result = await runParentAuthCheck(
      actor({ id: 'user-1', kind: 'user', tenantId: 'tenant-b' }),
    );
    expect(result.authorized).toBe(false);
  });

  test('system actor (tenantId=null, kind=system) is treated as global principal and bypasses check', async () => {
    const result = await runParentAuthCheck(actor({ id: 'sys', kind: 'system', tenantId: null }));
    expect(result.authorized).toBe(true);
  });
});

describe('evaluateRouteAuth — permission scope construction', () => {
  function makeEvaluator() {
    const seen: Array<{ action: string; scope: Record<string, unknown> }> = [];
    return {
      seen,
      evaluator: {
        can: async (_subject: unknown, action: string, scope: Record<string, unknown>) => {
          seen.push({ action, scope });
          return true;
        },
      },
    };
  }

  test('single-tenant actor (tenantId=null) reaches the evaluator as null, not undefined', async () => {
    // Regression: `?? undefined` coercion told the evaluator "no tenant
    // level", filtering every tenant/resource-scoped grant — single-tenant
    // deploys denied all entity-route permissions.
    const { seen, evaluator } = makeEvaluator();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('actor', actor({ id: 'user-1', kind: 'user', tenantId: null }));
      await next();
    });
    app.post('/threads', async c => {
      const result = await evaluateRouteAuth(
        c,
        {
          permission: {
            requires: 'community:container.write',
            scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
          },
        },
        { permissionEvaluator: evaluator },
      );
      return c.json({ authorized: result.authorized });
    });

    const res = await app.request('/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId: 'c-1' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.scope.tenantId).toBeNull();
    expect(seen[0]!.scope.resourceId).toBe('c-1');
  });

  test('record: scope resolves the id from the JSON body on flat named-op routes', async () => {
    // Flat transition/fieldUpdate routes (POST /threads/publish) carry the
    // record id in the body, not the URL — the record lookup must fall back
    // to body.id instead of 404ing.
    const { seen, evaluator } = makeEvaluator();
    const adapter = {
      getById: async (id: string) => (id === 't-1' ? { id: 't-1', containerId: 'c-9' } : null),
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('actor', actor({ id: 'user-1', kind: 'user', tenantId: null }));
      await next();
    });
    app.post('/threads/publish', async c => {
      const result = await evaluateRouteAuth(
        c,
        {
          permission: {
            requires: 'community:container.write',
            scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
          },
        },
        { permissionEvaluator: evaluator, adapter },
      );
      return c.json({ authorized: result.authorized });
    });

    const res = await app.request('/threads/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 't-1' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.scope.resourceId).toBe('c-9');
  });
});
