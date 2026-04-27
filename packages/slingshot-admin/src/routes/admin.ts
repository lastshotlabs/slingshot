import { randomUUID } from 'crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  createRoute,
  cursorParams,
  errorResponse,
  getClientIp,
  parseCursorParams,
} from '@lastshotlabs/slingshot-core';
import type {
  AuditLogProvider,
  PermissionEvaluator,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import type {
  ManagedUserProvider,
  ManagedUserRecord,
  ManagedUserScope,
  SessionRecord,
} from '@lastshotlabs/slingshot-core';
import { createTypedRouter, registerRoute } from '../lib/typedRoute';
import type { AdminEnv } from '../types/env';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ErrorResponse = z.object({ error: z.string() });

const AdminUserRecord = z
  .object({
    id: z.string(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    externalId: z.string().optional(),
    status: z.enum(['active', 'suspended']).optional(),
    provider: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('AdminUserRecord');

const AdminUserListResponse = z
  .object({
    users: z.array(AdminUserRecord),
    nextCursor: z.string().optional(),
  })
  .openapi('AdminUserListResponse');

const AdminUserResponse = AdminUserRecord.openapi('AdminUserResponse');

const AdminUpdateUserBody = z.object({
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  externalId: z.string().optional(),
});

const AdminSuspendBody = z.object({
  reason: z.string().optional(),
});

const AdminSetRolesBody = z.object({
  roles: z.array(z.string()),
});

const AdminRolesResponse = z
  .object({
    roles: z.array(z.string()),
  })
  .openapi('AdminRolesResponse');

const AdminSessionRecord = z
  .object({
    id: z.string(),
    userId: z.string(),
    createdAt: z.string().optional(),
    lastAccessedAt: z.string().optional(),
    ip: z.string().optional(),
    userAgent: z.string().optional(),
  })
  .openapi('AdminSessionRecord');

const AdminSessionListResponse = z
  .object({
    sessions: z.array(AdminSessionRecord),
  })
  .openapi('AdminSessionListResponse');

const AdminMessageResponse = z.object({ message: z.string() }).openapi('AdminMessageResponse');

const AdminCapabilitiesResponse = z
  .object({
    canListUsers: z.boolean(),
    canSearchUsers: z.boolean(),
    canViewUser: z.boolean(),
    canEditUser: z.boolean().optional(),
    canSuspendUsers: z.boolean().optional(),
    canDeleteUsers: z.boolean().optional(),
    canViewSessions: z.boolean().optional(),
    canRevokeSessions: z.boolean().optional(),
    canManageRoles: z.boolean().optional(),
    managedUserProvider: z.string(),
  })
  .openapi('AdminCapabilitiesResponse');

const AuditLogEntrySchema = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    sessionId: z.string().nullable(),
    requestTenantId: z.string().nullable(),
    method: z.string(),
    path: z.string(),
    status: z.number(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    action: z.string().optional(),
    resource: z.string().optional(),
    resourceId: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
    createdAt: z.string(),
  })
  .openapi('AuditLogEntry');

const AuditLogListResponse = z
  .object({
    items: z.array(AuditLogEntrySchema),
    nextCursor: z.string().optional(),
  })
  .openapi('AuditLogListResponse');

const tags = ['Admin'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a SessionRecord to the AdminSessionRecord API shape. */
function toAdminSession(session: SessionRecord): z.infer<typeof AdminSessionRecord> {
  return {
    id: session.sessionId,
    userId: session.userId,
    createdAt: session.createdAt != null ? new Date(session.createdAt).toISOString() : undefined,
    lastAccessedAt:
      session.lastActiveAt != null ? new Date(session.lastActiveAt).toISOString() : undefined,
    ip: session.ip,
    userAgent: session.userAgent,
  };
}

/** Map a ManagedUserRecord to the AdminUserRecord API shape. */
function toAdminUser(user: ManagedUserRecord): z.infer<typeof AdminUserRecord> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    externalId: user.externalId,
    status: user.status,
    provider: user.provider,
    metadata: user.metadata,
  };
}

function getManagedUserScope(c: Context<AdminEnv>): ManagedUserScope {
  const principal = c.get('adminPrincipal');
  return principal.tenantId ? { tenantId: principal.tenantId } : {};
}

async function getScopedUser(
  c: Context<AdminEnv>,
  managedUserProvider: ManagedUserProvider,
  userId: string,
): Promise<ManagedUserRecord | null> {
  return managedUserProvider.getUser(userId, getManagedUserScope(c));
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface AdminRouterConfig {
  managedUserProvider: ManagedUserProvider;
  bus: SlingshotEventBus;
  evaluator: PermissionEvaluator;
  auditLog?: AuditLogProvider;
}

async function checkPermission(
  c: Context<AdminEnv>,
  evaluator: PermissionEvaluator,
  action: string,
  resource: { type: string; id?: string; tenantId?: string },
): Promise<boolean> {
  const principal = c.get('adminPrincipal');
  return evaluator.can({ subjectId: principal.subject, subjectType: 'user' }, action, {
    tenantId: resource.tenantId ?? principal.tenantId,
    resourceType: resource.type,
    resourceId: resource.id,
  });
}

async function tryLogAuditEntry(
  auditLog: AuditLogProvider | undefined,
  entry: Parameters<AuditLogProvider['logEntry']>[0],
): Promise<void> {
  if (!auditLog) return;
  try {
    await auditLog.logEntry(entry);
  } catch (err) {
    console.error('[slingshot-admin] Failed to write audit log entry', err);
  }
}

export function createAdminRouter(config: AdminRouterConfig) {
  const { managedUserProvider, bus, evaluator } = config;
  const router = createTypedRouter();

  // -------------------------------------------------------------------------
  // GET /users — paginated user list
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/users',
      summary: 'List users',
      description:
        'Returns a paginated list of users. Supports cursor pagination and optional email/search filter.',
      tags,
      request: {
        query: z.object({
          ...cursorParams({ limit: 50, maxLimit: 200 }).shape,
          search: z.string().optional().describe('Filter by email (partial match)'),
          status: z.enum(['active', 'suspended']).optional().describe('Filter by account status'),
          role: z.string().optional().describe('Filter by role'),
          createdAfter: z.string().optional().describe('Filter by creation date (ISO 8601)'),
          createdBefore: z.string().optional().describe('Filter by creation date (ISO 8601)'),
          sortBy: z.enum(['createdAt', 'email']).optional().describe('Sort field'),
          sortDir: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminUserListResponse } },
          description: 'Paginated user list.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:user' })))
        return errorResponse(c, 'Forbidden', 403);
      const query = c.req.query();
      const { limit, cursor } = parseCursorParams(query, { limit: 50, maxLimit: 200 });

      const result = await managedUserProvider.listUsers({
        tenantId: c.get('adminPrincipal').tenantId,
        limit,
        cursor,
        search: query.search,
        status: query.status as 'active' | 'suspended' | undefined,
        role: query.role,
        createdAfter: query.createdAfter,
        createdBefore: query.createdBefore,
        sortBy: query.sortBy as 'createdAt' | 'email' | undefined,
        sortDir: query.sortDir as 'asc' | 'desc' | undefined,
      });

      return c.json(
        {
          users: result.items.map(toAdminUser),
          nextCursor: result.nextCursor,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /users/:userId — get single user
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/users/:userId',
      summary: 'Get a user',
      description: 'Returns a single user record by ID.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminUserResponse } },
          description: 'User record.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:user', id: userId })))
        return errorResponse(c, 'Forbidden', 403);
      const user = await getScopedUser(c, managedUserProvider, userId);
      if (!user) return errorResponse(c, 'User not found', 404);
      return c.json(toAdminUser(user), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /users/:userId — update profile
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'patch',
      path: '/users/:userId',
      summary: 'Update user profile',
      description: 'Updates display name, first/last name, or external ID for a user.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
        body: { content: { 'application/json': { schema: AdminUpdateUserBody } } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminMessageResponse } },
          description: 'Profile updated.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'write', { type: 'admin:user', id: userId })))
        return errorResponse(c, 'Forbidden', 403);
      const body = AdminUpdateUserBody.parse(await c.req.json());

      if (!managedUserProvider.updateUser) {
        return c.json(
          { error: 'updateUser not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const updated = await managedUserProvider.updateUser({
        userId,
        tenantId: c.get('adminPrincipal').tenantId,
        ...body,
      });
      if (!updated) return errorResponse(c, 'User not found', 404);

      const principal = c.get('adminPrincipal');
      bus.emit('security.admin.user.modified', {
        userId,
        meta: {
          fields: Object.keys(body),
          actorId: principal.subject,
          ip: getClientIp(c),
          requestId: c.get('requestId'),
        },
      });
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.user.update',
        resource: 'user',
        resourceId: userId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ message: 'Profile updated' }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /users/:userId/suspend
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'post',
      path: '/users/:userId/suspend',
      summary: 'Suspend a user',
      description: 'Suspends a user account. Suspended users cannot log in.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
        body: { content: { 'application/json': { schema: AdminSuspendBody } }, required: false },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminMessageResponse } },
          description: 'User suspended.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'suspend', { type: 'admin:user', id: userId })))
        return errorResponse(c, 'Forbidden', 403);

      if (!managedUserProvider.suspendUser) {
        return c.json(
          { error: 'Suspend not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      let reason: string | undefined;
      try {
        const body = (await c.req.json().catch(() => ({}))) as z.infer<typeof AdminSuspendBody>;
        reason = body.reason;
      } catch {
        // body is optional
      }

      const principal = c.get('adminPrincipal');
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      await managedUserProvider.suspendUser({
        userId,
        reason,
        actorId: principal.subject,
        tenantId: principal.tenantId,
      });

      bus.emit('security.auth.account.suspended', {
        userId,
        meta: {
          reason,
          actorId: principal.subject,
          ip: getClientIp(c),
          requestId: c.get('requestId'),
        },
      });
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.user.suspend',
        resource: 'user',
        resourceId: userId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ message: 'User suspended' }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /users/:userId/unsuspend
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'post',
      path: '/users/:userId/unsuspend',
      summary: 'Unsuspend a user',
      description: 'Restores a suspended user account.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminMessageResponse } },
          description: 'User unsuspended.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'suspend', { type: 'admin:user', id: userId })))
        return errorResponse(c, 'Forbidden', 403);

      if (!managedUserProvider.unsuspendUser) {
        return c.json(
          { error: 'Unsuspend not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const principal = c.get('adminPrincipal');
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      await managedUserProvider.unsuspendUser({
        userId,
        actorId: principal.subject,
        tenantId: principal.tenantId,
      });

      bus.emit('security.auth.account.unsuspended', {
        userId,
        meta: {
          actorId: principal.subject,
          ip: getClientIp(c),
          requestId: c.get('requestId'),
        },
      });
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.user.unsuspend',
        resource: 'user',
        resourceId: userId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ message: 'User unsuspended' }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /users/:userId/roles
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/users/:userId/roles',
      summary: 'Get user roles',
      description: 'Returns the app-wide roles assigned to a user.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminRolesResponse } },
          description: 'User roles.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:role' })))
        return errorResponse(c, 'Forbidden', 403);
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      if (!managedUserProvider.getRoles) {
        return c.json({ roles: [] }, 200);
      }
      const roles = await managedUserProvider.getRoles(userId, getManagedUserScope(c));
      return c.json({ roles }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /users/:userId/roles
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'put',
      path: '/users/:userId/roles',
      summary: 'Set user roles',
      description: 'Replaces all app-wide roles for a user.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
        body: { content: { 'application/json': { schema: AdminSetRolesBody } } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminRolesResponse } },
          description: 'Updated roles.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'write', { type: 'admin:role' })))
        return errorResponse(c, 'Forbidden', 403);
      const { roles } = AdminSetRolesBody.parse(await c.req.json());

      if (!managedUserProvider.setRoles) {
        return c.json(
          { error: 'Set roles not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const principal = c.get('adminPrincipal');
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      await managedUserProvider.setRoles(userId, roles, getManagedUserScope(c));

      bus.emit('security.admin.role.changed', {
        userId,
        meta: {
          roles,
          actorId: principal.subject,
          ip: getClientIp(c),
          requestId: c.get('requestId'),
        },
      });
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.role.set',
        resource: 'user',
        resourceId: userId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ roles }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /users/:userId — delete user
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'delete',
      path: '/users/:userId',
      summary: 'Delete a user',
      description: 'Permanently deletes a user account and revokes all sessions.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminMessageResponse } },
          description: 'User deleted.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'delete', { type: 'admin:user', id: userId })))
        return errorResponse(c, 'Forbidden', 403);

      if (!managedUserProvider.deleteUser) {
        return c.json(
          { error: 'deleteUser not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const principal = c.get('adminPrincipal');
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      await managedUserProvider.deleteUser(userId, getManagedUserScope(c));
      bus.emit('security.admin.user.deleted', {
        userId,
        meta: {
          actorId: principal.subject,
          ip: getClientIp(c),
          requestId: c.get('requestId'),
        },
      });
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.user.delete',
        resource: 'user',
        resourceId: userId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ message: 'User deleted' }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /users/:userId/sessions
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/users/:userId/sessions',
      summary: 'List user sessions',
      description: 'Returns all active sessions for a user.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminSessionListResponse } },
          description: 'Session list.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:session' })))
        return errorResponse(c, 'Forbidden', 403);
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      if (!managedUserProvider.listSessions) {
        return c.json({ sessions: [] }, 200);
      }
      const sessions = await managedUserProvider.listSessions(userId, getManagedUserScope(c));
      return c.json({ sessions: sessions.map(toAdminSession) }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /users/:userId/sessions — revoke all sessions
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'delete',
      path: '/users/:userId/sessions',
      summary: 'Revoke all user sessions',
      description: 'Revokes all active sessions for a user, forcing them to re-authenticate.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminMessageResponse } },
          description: 'Sessions revoked.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'revoke', { type: 'admin:session' })))
        return errorResponse(c, 'Forbidden', 403);

      if (!managedUserProvider.revokeAllSessions) {
        return c.json(
          { error: 'Revoke all sessions not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const principal = c.get('adminPrincipal');
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      await managedUserProvider.revokeAllSessions(userId, getManagedUserScope(c));
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.session.revoke_all',
        resource: 'user',
        resourceId: userId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ message: 'Sessions revoked' }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /users/:userId/sessions/:sessionId — revoke specific session
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'delete',
      path: '/users/:userId/sessions/:sessionId',
      summary: 'Revoke a specific session',
      description: 'Revokes a single session for a user by session ID.',
      tags,
      request: {
        params: z.object({ userId: z.string(), sessionId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AdminMessageResponse } },
          description: 'Session revoked.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User or session not found.',
        },
        501: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Operation not supported by provider.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      const sessionId = c.req.param('sessionId') ?? '';
      if (
        !(await checkPermission(c, evaluator, 'revoke', { type: 'admin:session', id: sessionId }))
      )
        return errorResponse(c, 'Forbidden', 403);

      if (!managedUserProvider.revokeSession) {
        return c.json(
          { error: 'Revoke session not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const principal = c.get('adminPrincipal');
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      if (managedUserProvider.listSessions) {
        const sessions = await managedUserProvider.listSessions(userId, getManagedUserScope(c));
        if (!sessions.some(session => session.sessionId === sessionId)) {
          return errorResponse(c, 'Session not found', 404);
        }
      }
      await managedUserProvider.revokeSession(sessionId, getManagedUserScope(c));
      await tryLogAuditEntry(config.auditLog, {
        id: randomUUID(),
        userId: principal.subject,
        sessionId: null,
        requestTenantId: principal.tenantId ?? null,
        method: c.req.method,
        path: c.req.path,
        status: 200,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent') ?? null,
        action: 'admin.session.revoke',
        resource: 'session',
        resourceId: sessionId,
        meta: { target: userId },
        requestId: c.get('requestId'),
        createdAt: new Date().toISOString(),
      });
      return c.json({ message: 'Session revoked' }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /capabilities — managed user provider capabilities
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/capabilities',
      summary: 'Get admin capabilities',
      description: 'Returns the capabilities supported by the configured managed user provider.',
      tags,
      responses: {
        200: {
          content: { 'application/json': { schema: AdminCapabilitiesResponse } },
          description: 'Capabilities.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:user' })))
        return errorResponse(c, 'Forbidden', 403);
      const capabilities = await managedUserProvider.getCapabilities();
      return c.json(
        {
          ...capabilities,
          managedUserProvider: managedUserProvider.name,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /audit-log — paginated audit log
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/audit-log',
      summary: 'Get audit log',
      description: 'Returns paginated audit log entries.',
      tags,
      request: {
        query: z.object({
          ...cursorParams({ limit: 50, maxLimit: 200 }).shape,
          after: z.string().optional().describe('Filter entries after this ISO 8601 date'),
          before: z.string().optional().describe('Filter entries before this ISO 8601 date'),
          userId: z.string().optional().describe('Filter by user ID'),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AuditLogListResponse } },
          description: 'Paginated audit log entries.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:audit' })))
        return errorResponse(c, 'Forbidden', 403);
      if (!config.auditLog) {
        return c.json({ items: [] }, 200);
      }
      const principal = c.get('adminPrincipal');
      const query = c.req.query();
      const { limit, cursor } = parseCursorParams(query, { limit: 50, maxLimit: 200 });
      const result = await config.auditLog.getLogs({
        limit,
        cursor,
        requestTenantId: principal.tenantId,
        after: query.after,
        before: query.before,
        userId: query.userId,
      });
      return c.json(result, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /users/:userId/audit-log — per-user audit log
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/users/:userId/audit-log',
      summary: 'Get user audit log',
      description: 'Returns paginated audit log entries for a specific user.',
      tags,
      request: {
        params: z.object({ userId: z.string() }),
        query: z.object({
          ...cursorParams({ limit: 50, maxLimit: 200 }).shape,
          after: z.string().optional().describe('Filter entries after this ISO 8601 date'),
          before: z.string().optional().describe('Filter entries before this ISO 8601 date'),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: AuditLogListResponse } },
          description: 'Paginated audit log entries.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'User not found.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      const userId = c.req.param('userId') ?? '';
      if (!(await checkPermission(c, evaluator, 'read', { type: 'admin:audit' })))
        return errorResponse(c, 'Forbidden', 403);
      if (!config.auditLog) {
        return c.json({ items: [] }, 200);
      }
      if (!(await getScopedUser(c, managedUserProvider, userId))) {
        return errorResponse(c, 'User not found', 404);
      }
      const principal = c.get('adminPrincipal');
      const query = c.req.query();
      const { limit, cursor } = parseCursorParams(query, { limit: 50, maxLimit: 200 });
      const result = await config.auditLog.getLogs({
        limit,
        cursor,
        userId,
        requestTenantId: principal.tenantId,
        after: query.after,
        before: query.before,
      });
      return c.json(result, 200);
    },
  );

  return router;
}
