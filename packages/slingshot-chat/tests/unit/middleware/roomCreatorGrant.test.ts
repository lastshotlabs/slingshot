import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { createRoomCreatorGrantMiddleware } from '../../../src/middleware/roomCreatorGrant';
import type { RoomMember, RoomMemberAdapter } from '../../../src/types';
import { setVar } from './_helpers';

interface CreateGrantInput {
  subjectId: string;
  resourceType: string;
  resourceId: string;
  roles: string[];
}

interface CreateMemberInput {
  roomId: string;
  userId: string;
  role: string;
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

function stubMemberAdapter() {
  const created: CreateMemberInput[] = [];
  const adapter: RoomMemberAdapter = {
    async create(input: CreateMemberInput) {
      created.push(input);
      return {
        ...input,
        id: 'member-1',
        joinedAt: new Date().toISOString(),
      } as unknown as RoomMember;
    },
  } as unknown as RoomMemberAdapter;
  return { adapter, created };
}

function buildApp(opts: {
  permissionsAdapter: PermissionsAdapter;
  memberAdapter: RoomMemberAdapter;
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
    createRoomCreatorGrantMiddleware({
      memberAdapter: opts.memberAdapter,
      permissionsAdapter: opts.permissionsAdapter,
      tenantId: 'default',
    }),
  );
  app.post('/rooms', c => c.json(opts.responseBody, (opts.responseStatus ?? 200) as 200));
  return app;
}

async function post(app: ReturnType<typeof buildApp>) {
  return app.request('/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('roomCreatorGrant middleware', () => {
  test('creates owner member and RBAC grant on room creation', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: memberAdapter, created } = stubMemberAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      memberAdapter,
      actorId: 'user-1',
      responseBody: { id: 'room-1' },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(created.length).toBe(1);
    expect(created[0]!.roomId).toBe('room-1');
    expect(created[0]!.userId).toBe('user-1');
    expect(created[0]!.role).toBe('owner');
    expect(grants.length).toBe(1);
    expect(grants[0]!.subjectId).toBe('user-1');
    expect(grants[0]!.resourceType).toBe('chat:room');
    expect(grants[0]!.resourceId).toBe('room-1');
    expect(grants[0]!.roles).toEqual(['owner']);
  });

  test('skips on non-2xx response', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: memberAdapter, created } = stubMemberAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      memberAdapter,
      actorId: 'user-1',
      responseBody: { error: 'fail' },
      responseStatus: 400,
    });

    const res = await post(app);
    expect(res.status).toBe(400);
    expect(created.length).toBe(0);
    expect(grants.length).toBe(0);
  });

  test('skips when no actor is present', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: memberAdapter, created } = stubMemberAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      memberAdapter,
      actorId: null,
      responseBody: { id: 'room-1' },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(created.length).toBe(0);
    expect(grants.length).toBe(0);
  });

  test('skips when response has no id', async () => {
    const { adapter: permsAdapter, grants } = stubPermissionsAdapter();
    const { adapter: memberAdapter, created } = stubMemberAdapter();
    const app = buildApp({
      permissionsAdapter: permsAdapter,
      memberAdapter,
      actorId: 'user-1',
      responseBody: { name: 'room without id' },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(created.length).toBe(0);
    expect(grants.length).toBe(0);
  });
});
