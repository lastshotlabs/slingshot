/**
 * Regression: every parameterized route in the admin plugin must emit brace-form
 * paths (`/users/{userId}`) in the OpenAPI doc. The plugin sources keep the
 * brace-form literal directly so `@hono/zod-openapi` registers the right shape;
 * runtime hono routing converts brace→colon internally on registration.
 *
 * If anyone reverts a `path: '/users/{userId}'` literal back to colon form, this
 * test catches it before the spec ships.
 */
import { describe, expect, it } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createAdminRouter } from '../../src/routes/admin';
import { createMailRouter } from '../../src/routes/mail';
import { createPermissionsRouter } from '../../src/routes/permissions';

function stubManagedUserProvider() {
  return {
    name: 'stub',
    listUsers: async () => ({ users: [], total: 0, hasMore: false }),
    getUser: async () => null,
    updateUser: async () => null,
    suspendUser: async () => null,
    unsuspendUser: async () => null,
    deleteUser: async () => null,
    listUserRoles: async () => [],
    setUserRoles: async () => null,
    listUserSessions: async () => ({ sessions: [], total: 0 }),
    revokeUserSession: async () => null,
    listUserAuditLog: async () => ({ entries: [], total: 0, hasMore: false }),
  } as never;
}

function stubBus() {
  return { emit: () => {}, on: () => {}, off: () => {}, drain: async () => {} } as never;
}

function stubEvaluator() {
  return { can: async () => true } as never;
}

describe('admin OpenAPI path emission', () => {
  it('admin user-management routes emit brace-form params in the OpenAPI doc', () => {
    const app = new OpenAPIHono<AppEnv>();
    app.route(
      '/',
      createAdminRouter({
        managedUserProvider: stubManagedUserProvider(),
        bus: stubBus(),
        evaluator: stubEvaluator(),
      }),
    );

    const doc = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'admin', version: '0.0.0' },
    });
    const paths = Object.keys(doc.paths ?? {});

    // Spot-check the parameterized paths converted in this fix.
    expect(paths).toContain('/users/{userId}');
    expect(paths).toContain('/users/{userId}/suspend');
    expect(paths).toContain('/users/{userId}/unsuspend');
    expect(paths).toContain('/users/{userId}/roles');
    expect(paths).toContain('/users/{userId}/sessions');
    expect(paths).toContain('/users/{userId}/sessions/{sessionId}');
    expect(paths).toContain('/users/{userId}/audit-log');

    // Defense in depth — no colon-form literals should leak into the spec.
    for (const path of paths) {
      expect(path).not.toContain(':');
    }
  });

  it('admin mail and permissions routes emit brace-form params', () => {
    const mail = new OpenAPIHono<AppEnv>();
    mail.route('/', createMailRouter({ bus: stubBus(), evaluator: stubEvaluator() } as never));
    const mailDoc = mail.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'mail', version: '0.0.0' },
    });
    const mailPaths = Object.keys(mailDoc.paths ?? {});
    expect(mailPaths).toContain('/mail/templates/{name}/preview');
    for (const p of mailPaths) expect(p).not.toContain(':');

    const perms = new OpenAPIHono<AppEnv>();
    perms.route(
      '/',
      createPermissionsRouter({
        bus: stubBus(),
        evaluator: stubEvaluator(),
        registry: { register: () => {}, get: () => null } as never,
        adapter: {
          createGrant: async () => ({ id: 'g1' }),
          deleteGrant: async () => null,
          listGrantsForSubject: async () => [],
          listGrantsForResource: async () => [],
        } as never,
      } as never),
    );
    const permsDoc = perms.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'perms', version: '0.0.0' },
    });
    const permsPaths = Object.keys(permsDoc.paths ?? {});
    expect(permsPaths).toContain('/grants/{grantId}');
    expect(permsPaths).toContain('/subjects/{subjectType}/{subjectId}/grants');
    expect(permsPaths).toContain('/resources/{type}/{id}/grants');
    for (const p of permsPaths) expect(p).not.toContain(':');
  });
});
