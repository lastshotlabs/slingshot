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
