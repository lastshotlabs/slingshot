import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { createMemberGrantMiddleware } from '../../../src/middleware/memberGrant';
import { setVar } from './_helpers';

interface CreateGrantInput {
  subjectId: string;
  resourceType: string;
  resourceId: string;
  roles: string[];
  grantedBy: string;
}

function stubPermissionsAdapter() {
  const grants: CreateGrantInput[] = [];
  const adapter: PermissionsAdapter = {
    async createGrant(grant: CreateGrantInput) {
      grants.push(grant);
      return 'grant-1';
    },
  } as unknown as PermissionsAdapter;
  return { adapter, grants };
}

function buildApp(opts: {
  permissionsAdapter: PermissionsAdapter;
  actorId?: string | null;
  responseBody: Record<string, unknown>;
  responseStatus?: number;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (opts.actorId) {
      setVar(c, 'actor', { id: opts.actorId, kind: 'user', roles: [], tenantId: null });
    }
    await next();
  });
  app.use(
    '*',
    createMemberGrantMiddleware({
      permissionsAdapter: opts.permissionsAdapter,
      tenantId: 'default',
    }),
  );
  app.post('/rooms/:roomId/members', c =>
    c.json(opts.responseBody, (opts.responseStatus ?? 200) as 200),
  );
  return app;
}

describe('memberGrant middleware', () => {
  test('creates member grant on successful member creation', async () => {
    const { adapter, grants } = stubPermissionsAdapter();
    const app = buildApp({
      permissionsAdapter: adapter,
      actorId: 'admin-1',
      responseBody: { userId: 'user-2', roomId: 'room-1' },
    });

    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(200);
    expect(grants.length).toBe(1);
    expect(grants[0]!.subjectId).toBe('user-2');
    expect(grants[0]!.resourceType).toBe('chat:room');
    expect(grants[0]!.resourceId).toBe('room-1');
    expect(grants[0]!.roles).toEqual(['member']);
    expect(grants[0]!.grantedBy).toBe('admin-1');
  });

  test('skips on non-2xx response', async () => {
    const { adapter, grants } = stubPermissionsAdapter();
    const app = buildApp({
      permissionsAdapter: adapter,
      actorId: 'admin-1',
      responseBody: { error: 'fail' },
      responseStatus: 400,
    });

    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(400);
    expect(grants.length).toBe(0);
  });

  test('skips when no actor is present', async () => {
    const { adapter, grants } = stubPermissionsAdapter();
    const app = buildApp({
      permissionsAdapter: adapter,
      actorId: null,
      responseBody: { userId: 'user-2', roomId: 'room-1' },
    });

    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    expect(res.status).toBe(200);
    expect(grants.length).toBe(0);
  });

  test('skips when response lacks userId or roomId', async () => {
    const { adapter, grants } = stubPermissionsAdapter();
    const app = buildApp({
      permissionsAdapter: adapter,
      actorId: 'admin-1',
      responseBody: { partial: 'data' },
    });

    const res = await app.request('/rooms/room-1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(grants.length).toBe(0);
  });
});
