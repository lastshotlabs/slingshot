import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionGrant, PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { createGrantManagerMiddleware } from '../../../src/middleware/grantManager';
import { setVar } from './_helpers';

type CreateGrantInput = Omit<PermissionGrant, 'id' | 'grantedAt'>;

function stubAdapter() {
  const created: CreateGrantInput[] = [];
  const revoked: string[] = [];
  const grants: PermissionGrant[] = [];
  const adapter: PermissionsAdapter = {
    async createGrant(grant) {
      created.push(grant);
      grants.push({
        ...grant,
        id: `grant-${created.length}`,
        grantedAt: new Date(),
      });
      return 'grant-' + created.length;
    },
    async createGrants(grantInputs) {
      const ids: string[] = [];
      for (const grant of grantInputs) {
        created.push(grant);
        const id = `grant-${created.length}`;
        grants.push({
          ...grant,
          id,
          grantedAt: new Date(),
        });
        ids.push(id);
      }
      return ids;
    },
    async revokeGrant(id) {
      const grant = grants.find(candidate => candidate.id === id);
      if (grant) {
        grant.revokedAt = new Date();
        grant.revokedBy = 'admin1';
      }
      revoked.push(id);
      return true;
    },
    async getGrantsForSubject(subjectId, subjectType, scope) {
      return grants.filter(
        grant =>
          grant.subjectId === subjectId &&
          (subjectType === undefined || grant.subjectType === subjectType) &&
          (scope?.tenantId === undefined || grant.tenantId === scope.tenantId) &&
          (scope?.resourceType === undefined || grant.resourceType === scope.resourceType) &&
          (scope?.resourceId === undefined || grant.resourceId === scope.resourceId),
      );
    },
    async getEffectiveGrantsForSubject() {
      return [];
    },
    async listGrantHistory() {
      return [];
    },
    async listGrantsOnResource() {
      return [];
    },
    async deleteAllGrantsForSubject() {
      /* noop */
    },
    async deleteAllGrantsOnResource(resourceType, resourceId, tenantId) {
      for (let i = grants.length - 1; i >= 0; i -= 1) {
        const grant = grants[i];
        if (
          grant?.resourceType === resourceType &&
          grant.resourceId === resourceId &&
          (tenantId === undefined || grant.tenantId === tenantId)
        ) {
          grants.splice(i, 1);
        }
      }
    },
  };
  return { adapter, created, revoked, grants };
}

function buildApp(
  adapter: PermissionsAdapter,
  result: Record<string, unknown>,
  getMemberById?: (memberId: string) => Promise<Record<string, unknown> | null>,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setVar(c, 'communityPrincipal', { subject: 'admin1', roles: ['admin'] });
    await next();
  });
  app.use(
    '*',
    createGrantManagerMiddleware({
      permissionsAdapter: adapter,
      getMemberById: async memberId => (getMemberById ? await getMemberById(memberId) : null),
    }),
  );
  app.post('/containers/:containerId/members', c => c.json(result));
  app.delete('/containers/:containerId/members/:id', () => new Response(null, { status: 204 }));
  return app;
}

describe('grantManager middleware', () => {
  test('creates moderator grant on moderator role assignment', async () => {
    const { adapter, created } = stubAdapter();
    const app = buildApp(adapter, {
      userId: 'u1',
      containerId: 'c1',
      role: 'moderator',
    });

    const res = await app.request('/containers/c1/members', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(created.length).toBe(1);
    expect(created[0]?.roles).toEqual(['moderator']);
    expect(created[0]?.resourceId).toBe('c1');
  });

  test('creates owner grant on owner role assignment', async () => {
    const { adapter, created } = stubAdapter();
    const app = buildApp(adapter, {
      userId: 'u1',
      containerId: 'c1',
      role: 'owner',
    });

    const res = await app.request('/containers/c1/members', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(created.length).toBe(1);
    expect(created[0]?.roles).toEqual(['owner']);
  });

  test('does nothing for member role', async () => {
    const { adapter, created } = stubAdapter();
    const app = buildApp(adapter, {
      userId: 'u1',
      containerId: 'c1',
      role: 'member',
    });

    const res = await app.request('/containers/c1/members', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(created.length).toBe(0);
  });

  test('revokes stale owner grant before creating a moderator grant', async () => {
    const { adapter, created, revoked, grants } = stubAdapter();
    grants.push({
      id: 'grant-existing-owner',
      subjectId: 'u1',
      subjectType: 'user',
      tenantId: null,
      resourceType: 'community:container',
      resourceId: 'c1',
      roles: ['owner'],
      effect: 'allow',
      grantedBy: 'seed',
      grantedAt: new Date(),
    });
    const app = buildApp(adapter, {
      userId: 'u1',
      containerId: 'c1',
      role: 'moderator',
    });

    const res = await app.request('/containers/c1/members', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(revoked).toContain('grant-existing-owner');
    expect(created.at(-1)?.roles).toEqual(['moderator']);
  });

  test('revokes managed grants when a member is deleted', async () => {
    const { adapter, revoked, grants } = stubAdapter();
    grants.push({
      id: 'grant-existing-moderator',
      subjectId: 'u1',
      subjectType: 'user',
      tenantId: null,
      resourceType: 'community:container',
      resourceId: 'c1',
      roles: ['moderator'],
      effect: 'allow',
      grantedBy: 'seed',
      grantedAt: new Date(),
    });
    const app = buildApp(adapter, {}, async memberId => {
      expect(memberId).toBe('member-1');
      return { userId: 'u1', containerId: 'c1', role: 'moderator' };
    });

    const res = await app.request('/containers/c1/members/member-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(revoked).toContain('grant-existing-moderator');
  });

  test('skips on non-2xx response', async () => {
    const { adapter, created } = stubAdapter();
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'communityPrincipal', { subject: 'admin1', roles: ['admin'] });
      await next();
    });
    app.use(
      '*',
      createGrantManagerMiddleware({
        permissionsAdapter: adapter,
        getMemberById: async () => null,
      }),
    );
    app.post('/containers/:containerId/members', c =>
      c.json({ error: 'nope', userId: 'u1', role: 'moderator' }, 400),
    );

    const res = await app.request('/containers/c1/members', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(created.length).toBe(0);
  });
});
