import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { PermissionsAdapter } from '@lastshotlabs/slingshot-core';
import { createMemberGrantRevokeMiddleware } from '../../../src/middleware/memberGrantRevoke';
import type { RoomMemberAdapter } from '../../../src/types';
import { setVar } from './_helpers';

describe('memberGrantRevoke', () => {
  test('revokes active room grants after successful membership deletion', async () => {
    const revoked: string[] = [];
    const permissionsAdapter = {
      getGrantsForSubject: async () => [
        { id: 'g1', effect: 'allow' },
        { id: 'g2', effect: 'allow', revokedAt: new Date() },
      ],
      revokeGrant: async (id: string) => {
        revoked.push(id);
        return true;
      },
    } as unknown as PermissionsAdapter;
    const memberAdapter = {
      getById: async () => ({ id: 'm1', userId: 'u1', roomId: 'r1' }),
    } as unknown as RoomMemberAdapter;
    const app = new Hono();
    app.use('*', async (c, next) => {
      setVar(c, 'actor', { id: 'owner', kind: 'user', tenantId: null });
      await next();
    });
    app.use(
      '/members/:id',
      createMemberGrantRevokeMiddleware({ permissionsAdapter, memberAdapter, tenantId: null }),
    );
    app.delete('/members/:id', c => c.body(null, 204));
    expect((await app.request('/members/m1', { method: 'DELETE' })).status).toBe(204);
    expect(revoked).toEqual(['g1']);
  });
});
