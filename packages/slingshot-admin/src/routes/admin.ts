import { randomUUID } from 'crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  createConsoleLogger,
  createRoute,
  cursorParams,
  errorResponse,
  getClientIp,
  parseCursorParams,
} from '@lastshotlabs/slingshot-core';
import type {
  AuditLogProvider,
  Logger,
  PermissionEvaluator,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import type {
  ManagedUserProvider,
  ManagedUserRecord,
  ManagedUserScope,
  SessionRecord,
} from '@lastshotlabs/slingshot-core';
import type { AdminRateLimitStore } from '../lib/rateLimitStore';
import { createMemoryRateLimitStore } from '../lib/rateLimitStore';
import { createTypedRouter, registerRoute } from '../lib/typedRoute';
import type { AdminEnv } from '../types/env';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const logger: Logger = createConsoleLogger({ base: { plugin: 'slingshot-admin' } });

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
  displayName: z.string().max(255).trim().optional(),
  firstName: z.string().max(255).trim().optional(),
  lastName: z.string().max(255).trim().optional(),
  externalId: z.string().max(255).optional(),
});

// `.max(1000)` caps the field that lands in the audit log. Without this an
// attacker can post a 100MB string and inflate audit storage on every
// suspension event.
const AdminSuspendBody = z.object({
  reason: z.string().max(1000).optional(),
});

const AdminSetRolesBody = z.object({
  roles: z.array(z.string().max(64)).max(100),
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
// Reusable validated param shapes
// ---------------------------------------------------------------------------

/** Validated user ID param — alphanumeric, hyphens, and underscores only. */
const UserIdParam = z.object({
  userId: z
    .string()
    .max(128)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'userId must contain only alphanumeric characters, hyphens, or underscores',
    ),
});

/** Validated session ID param — same constraints as userId. */
const SessionIdParam = z.object({
  sessionId: z
    .string()
    .max(128)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'sessionId must contain only alphanumeric characters, hyphens, or underscores',
    ),
});

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
  destructiveRateLimit?: {
    /** Window length in milliseconds. Default: 60000. */
    windowMs?: number;
    /** Max destructive requests per principal+route+IP in the window. Default: 30. */
    max?: number;
  };
  /**
   * Pluggable counter backing the destructive-mutation rate limiter. Defaults
   * to an in-process implementation; multi-instance deploys should pass a
   * shared (e.g. Redis) store so counters are coordinated across replicas.
   */
  rateLimitStore?: AdminRateLimitStore;
  /** Structured logger for operational warnings and errors. Defaults to console. */
  logger?: Logger;
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
    logger.error('[slingshot-admin] Failed to write audit log entry', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sentinel error raised by {@link requireAuditEntry} when the audit provider
 * fails. Route handlers catch this and return a 503 fail-closed response so
 * a destructive verb cannot complete without leaving an audit trail.
 */
class AuditLogUnavailableError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('audit-log-unavailable');
    this.name = 'AuditLogUnavailableError';
    this.cause = cause;
  }
}

/**
 * Fail-closed audit write for destructive verbs (delete, suspend, unsuspend,
 * role assignment, session revocation, etc.). When the audit provider rejects
 * we throw {@link AuditLogUnavailableError} so the caller can return 503 to
 * the client; this prevents destructive mutations from silently completing
 * without an audit trail when the audit backend is unhealthy.
 *
 * Read-only verbs continue using {@link tryLogAuditEntry}.
 */
async function requireAuditEntry(
  auditLog: AuditLogProvider | undefined,
  entry: Parameters<AuditLogProvider['logEntry']>[0],
): Promise<void> {
  if (!auditLog) return;
  try {
    await auditLog.logEntry(entry);
  } catch (err) {
    logger.error('[slingshot-admin] Audit log unavailable for destructive verb — failing closed', {
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      status: entry.status,
      requestId: entry.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AuditLogUnavailableError(err);
  }
}

/**
 * Wrap a handler body that issues `requireAuditEntry` calls. If the audit
 * provider is unavailable we surface a 503 response with a stable error code
 * so the destructive verb is fail-closed.
 */
async function withRequiredAudit<E extends AdminEnv>(
  c: Context<E>,
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AuditLogUnavailableError) {
      return c.json({ error: 'audit-log-unavailable' }, 503 as ContentfulStatusCode);
    }
    throw err;
  }
}

/**
 * Maximum byte length for free-form audit-log strings emitted by this package.
 *
 * P-ADMIN-6: every `auditEntry()` caller passes `action` and `resource` that
 * can flow into a database-backed audit store. We cap them at write time so
 * a misbehaving caller cannot inflate the audit row with a multi-megabyte
 * string. 256 is comfortably larger than any action verb the admin plugin
 * emits today and matches the order-of-magnitude limits used by typical
 * audit-log adapters (Postgres `varchar(256)`, etc.).
 */
const AUDIT_FIELD_MAX_LENGTH = 256;

function clampAuditField(value: string, fieldName: string): string {
  if (value.length <= AUDIT_FIELD_MAX_LENGTH) return value;
  logger.warn(
    `[slingshot-admin] audit ${fieldName} truncated from ${value.length} to ${AUDIT_FIELD_MAX_LENGTH} chars`,
  );
  return value.slice(0, AUDIT_FIELD_MAX_LENGTH);
}

function auditEntry(
  c: Context<AdminEnv>,
  action: string,
  resource: string,
  resourceId: string | undefined,
  status: number,
  meta: Record<string, unknown> = {},
): Parameters<AuditLogProvider['logEntry']>[0] {
  const principal = c.get('adminPrincipal');
  return {
    id: randomUUID(),
    userId: principal.subject,
    sessionId: null,
    requestTenantId: principal.tenantId ?? null,
    method: c.req.method,
    path: c.req.path,
    status,
    ip: getClientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
    action: clampAuditField(action, 'action'),
    resource: clampAuditField(resource, 'resource'),
    resourceId: resourceId !== undefined ? clampAuditField(resourceId, 'resourceId') : resourceId,
    meta,
    requestId: c.get('requestId'),
    createdAt: new Date().toISOString(),
  };
}

export function createAdminRouter(config: AdminRouterConfig) {
  const { managedUserProvider, bus, evaluator } = config;
  const router = createTypedRouter();
  const destructiveWindowMs = config.destructiveRateLimit?.windowMs ?? 60_000;
  const destructiveMax = config.destructiveRateLimit?.max ?? 30;
  const rateLimitStore: AdminRateLimitStore = config.rateLimitStore ?? createMemoryRateLimitStore();
  const routeLogger: Logger = config.logger ?? logger;

  async function checkDestructiveRateLimit(
    c: Context<AdminEnv>,
    action: string,
  ): Promise<Response | null> {
    if (destructiveMax <= 0) return null;
    const principal = c.get('adminPrincipal');
    const key = `${principal.subject}:${getClientIp(c) ?? 'unknown'}:${action}`;
    let result;
    try {
      result = await rateLimitStore.hit(key, {
        limit: destructiveMax,
        windowMs: destructiveWindowMs,
      });
    } catch (err) {
      // Fail-open on store errors so a Redis outage does not freeze admin
      // operations entirely. We still log so the operator notices.
      routeLogger.error('[slingshot-admin] Rate-limit store error — allowing request', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!result.exceeded) return null;
    const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    c.header('Retry-After', String(retryAfterSec));
    return c.json({ error: 'Too many admin mutations' }, 429 as ContentfulStatusCode);
  }

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
      // P-ADMIN-5: parseCursorParams already clamps the request limit to
      // [1, 200]. We additionally slice the provider response below so that
      // a buggy or malicious adapter that ignores the requested limit cannot
      // ship 100k rows back to the client (DoS via substring search on 'a').
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

      const cappedItems = result.items.length > limit ? result.items.slice(0, limit) : result.items;
      return c.json(
        {
          users: cappedItems.map(toAdminUser),
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
        params: UserIdParam,
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
        params: UserIdParam,
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
      if (!(await checkPermission(c, evaluator, 'write', { type: 'admin:user', id: userId }))) {
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.update', 'user', userId, 403, { target: userId }),
        );
        return errorResponse(c, 'Forbidden', 403);
      }
      let body: z.infer<typeof AdminUpdateUserBody>;
      try {
        body = AdminUpdateUserBody.parse(await c.req.json());
      } catch (err) {
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.update', 'user', userId, 400, {
            target: userId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }

      if (!managedUserProvider.updateUser) {
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.update', 'user', userId, 501, { target: userId }),
        );
        return c.json(
          { error: 'updateUser not supported by the configured managed user provider' },
          501 as ContentfulStatusCode,
        );
      }

      const principal = c.get('adminPrincipal');
      let updated: ManagedUserRecord | null;
      try {
        updated = await managedUserProvider.updateUser({
          userId,
          tenantId: principal.tenantId,
          ...body,
        });
      } catch (err) {
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.update', 'user', userId, 500, {
            target: userId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }
      if (!updated) {
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.update', 'user', userId, 404, { target: userId }),
        );
        return errorResponse(c, 'User not found', 404);
      }

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
        ...auditEntry(c, 'admin.user.update', 'user', userId, 200, { target: userId }),
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
        params: UserIdParam,
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
    async (c: Context<AdminEnv>) =>
      withRequiredAudit(c, async () => {
        const userId = c.req.param('userId') ?? '';
        if (!(await checkPermission(c, evaluator, 'suspend', { type: 'admin:user', id: userId }))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.suspend', 'user', userId, 403, { target: userId }),
          );
          return errorResponse(c, 'Forbidden', 403);
        }
        const rateLimited = await checkDestructiveRateLimit(c, 'admin.user.suspend');
        if (rateLimited) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.suspend', 'user', userId, 429, { target: userId }),
          );
          return rateLimited;
        }

        if (!managedUserProvider.suspendUser) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.suspend', 'user', userId, 501, { target: userId }),
          );
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
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.suspend', 'user', userId, 404, { target: userId }),
          );
          return errorResponse(c, 'User not found', 404);
        }
        await requireAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.suspend', 'user', userId, 202, {
            target: userId,
            phase: 'before-mutation',
          }),
        );
        try {
          await managedUserProvider.suspendUser({
            userId,
            reason,
            actorId: principal.subject,
            tenantId: principal.tenantId,
          });
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.suspend', 'user', userId, 500, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }

        bus.emit('security.auth.account.suspended', {
          userId,
          meta: {
            reason,
            actorId: principal.subject,
            ip: getClientIp(c),
            requestId: c.get('requestId'),
          },
        });
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.suspend', 'user', userId, 200, { target: userId }),
        );
        return c.json({ message: 'User suspended' }, 200);
      }),
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
        params: UserIdParam,
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
    async (c: Context<AdminEnv>) =>
      withRequiredAudit(c, async () => {
        const userId = c.req.param('userId') ?? '';
        if (!(await checkPermission(c, evaluator, 'suspend', { type: 'admin:user', id: userId }))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.unsuspend', 'user', userId, 403, { target: userId }),
          );
          return errorResponse(c, 'Forbidden', 403);
        }
        const rateLimited = await checkDestructiveRateLimit(c, 'admin.user.unsuspend');
        if (rateLimited) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.unsuspend', 'user', userId, 429, { target: userId }),
          );
          return rateLimited;
        }

        if (!managedUserProvider.unsuspendUser) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.unsuspend', 'user', userId, 501, { target: userId }),
          );
          return c.json(
            { error: 'Unsuspend not supported by the configured managed user provider' },
            501 as ContentfulStatusCode,
          );
        }

        const principal = c.get('adminPrincipal');

        if (!(await getScopedUser(c, managedUserProvider, userId))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.unsuspend', 'user', userId, 404, { target: userId }),
          );
          return errorResponse(c, 'User not found', 404);
        }
        await requireAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.unsuspend', 'user', userId, 202, {
            target: userId,
            phase: 'before-mutation',
          }),
        );
        try {
          await managedUserProvider.unsuspendUser({
            userId,
            actorId: principal.subject,
            tenantId: principal.tenantId,
          });
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.unsuspend', 'user', userId, 500, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }

        bus.emit('security.auth.account.unsuspended', {
          userId,
          meta: {
            actorId: principal.subject,
            ip: getClientIp(c),
            requestId: c.get('requestId'),
          },
        });
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.unsuspend', 'user', userId, 200, { target: userId }),
        );
        return c.json({ message: 'User unsuspended' }, 200);
      }),
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
        params: UserIdParam,
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
        params: UserIdParam,
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
    async (c: Context<AdminEnv>) =>
      withRequiredAudit(c, async () => {
        const userId = c.req.param('userId') ?? '';
        if (!(await checkPermission(c, evaluator, 'write', { type: 'admin:role' }))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.role.set', 'user', userId, 403, { target: userId }),
          );
          return errorResponse(c, 'Forbidden', 403);
        }
        const rateLimited = await checkDestructiveRateLimit(c, 'admin.role.set');
        if (rateLimited) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.role.set', 'user', userId, 429, { target: userId }),
          );
          return rateLimited;
        }
        let roles: z.infer<typeof AdminSetRolesBody>['roles'];
        try {
          ({ roles } = AdminSetRolesBody.parse(await c.req.json()));
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.role.set', 'user', userId, 400, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }

        if (!managedUserProvider.setRoles) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.role.set', 'user', userId, 501, { target: userId }),
          );
          return c.json(
            { error: 'Set roles not supported by the configured managed user provider' },
            501 as ContentfulStatusCode,
          );
        }

        const principal = c.get('adminPrincipal');
        if (!(await getScopedUser(c, managedUserProvider, userId))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.role.set', 'user', userId, 404, { target: userId }),
          );
          return errorResponse(c, 'User not found', 404);
        }
        await requireAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.role.set', 'user', userId, 202, {
            target: userId,
            phase: 'before-mutation',
          }),
        );
        try {
          await managedUserProvider.setRoles(userId, roles, getManagedUserScope(c));
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.role.set', 'user', userId, 500, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }

        bus.emit('security.admin.role.changed', {
          userId,
          meta: {
            roles,
            actorId: principal.subject,
            ip: getClientIp(c),
            requestId: c.get('requestId'),
          },
        });
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.role.set', 'user', userId, 200, { target: userId }),
        );
        return c.json({ roles }, 200);
      }),
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
        params: UserIdParam,
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
    async (c: Context<AdminEnv>) =>
      withRequiredAudit(c, async () => {
        const userId = c.req.param('userId') ?? '';
        if (!(await checkPermission(c, evaluator, 'delete', { type: 'admin:user', id: userId }))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.delete', 'user', userId, 403, { target: userId }),
          );
          return errorResponse(c, 'Forbidden', 403);
        }
        const rateLimited = await checkDestructiveRateLimit(c, 'admin.user.delete');
        if (rateLimited) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.delete', 'user', userId, 429, { target: userId }),
          );
          return rateLimited;
        }

        if (!managedUserProvider.deleteUser) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.delete', 'user', userId, 501, { target: userId }),
          );
          return c.json(
            { error: 'deleteUser not supported by the configured managed user provider' },
            501 as ContentfulStatusCode,
          );
        }

        const principal = c.get('adminPrincipal');
        if (!(await getScopedUser(c, managedUserProvider, userId))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.delete', 'user', userId, 404, { target: userId }),
          );
          return errorResponse(c, 'User not found', 404);
        }
        await requireAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.delete', 'user', userId, 202, {
            target: userId,
            phase: 'before-mutation',
          }),
        );
        try {
          await managedUserProvider.deleteUser(userId, getManagedUserScope(c));
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.user.delete', 'user', userId, 500, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }
        bus.emit('security.admin.user.deleted', {
          userId,
          meta: {
            actorId: principal.subject,
            ip: getClientIp(c),
            requestId: c.get('requestId'),
          },
        });
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.user.delete', 'user', userId, 200, { target: userId }),
        );
        return c.json({ message: 'User deleted' }, 200);
      }),
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
        params: UserIdParam,
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
        params: UserIdParam,
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
    async (c: Context<AdminEnv>) =>
      withRequiredAudit(c, async () => {
        const userId = c.req.param('userId') ?? '';
        if (!(await checkPermission(c, evaluator, 'revoke', { type: 'admin:session' }))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke_all', 'user', userId, 403, { target: userId }),
          );
          return errorResponse(c, 'Forbidden', 403);
        }
        const rateLimited = await checkDestructiveRateLimit(c, 'admin.session.revoke_all');
        if (rateLimited) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke_all', 'user', userId, 429, { target: userId }),
          );
          return rateLimited;
        }

        if (!managedUserProvider.revokeAllSessions) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke_all', 'user', userId, 501, { target: userId }),
          );
          return c.json(
            { error: 'Revoke all sessions not supported by the configured managed user provider' },
            501 as ContentfulStatusCode,
          );
        }

        if (!(await getScopedUser(c, managedUserProvider, userId))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke_all', 'user', userId, 404, { target: userId }),
          );
          return errorResponse(c, 'User not found', 404);
        }
        await requireAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.session.revoke_all', 'user', userId, 202, {
            target: userId,
            phase: 'before-mutation',
          }),
        );
        try {
          await managedUserProvider.revokeAllSessions(userId, getManagedUserScope(c));
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke_all', 'user', userId, 500, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.session.revoke_all', 'user', userId, 200, { target: userId }),
        );
        return c.json({ message: 'Sessions revoked' }, 200);
      }),
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
        params: UserIdParam.merge(SessionIdParam),
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
    async (c: Context<AdminEnv>) =>
      withRequiredAudit(c, async () => {
        const userId = c.req.param('userId') ?? '';
        const sessionId = c.req.param('sessionId') ?? '';
        if (
          !(await checkPermission(c, evaluator, 'revoke', { type: 'admin:session', id: sessionId }))
        ) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke', 'session', sessionId, 403, { target: userId }),
          );
          return errorResponse(c, 'Forbidden', 403);
        }
        const rateLimited = await checkDestructiveRateLimit(c, 'admin.session.revoke');
        if (rateLimited) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke', 'session', sessionId, 429, { target: userId }),
          );
          return rateLimited;
        }

        if (!managedUserProvider.revokeSession) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke', 'session', sessionId, 501, { target: userId }),
          );
          return c.json(
            { error: 'Revoke session not supported by the configured managed user provider' },
            501 as ContentfulStatusCode,
          );
        }

        if (!(await getScopedUser(c, managedUserProvider, userId))) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke', 'session', sessionId, 404, { target: userId }),
          );
          return errorResponse(c, 'User not found', 404);
        }
        if (managedUserProvider.listSessions) {
          const sessions = await managedUserProvider.listSessions(userId, getManagedUserScope(c));
          if (!sessions.some(session => session.sessionId === sessionId)) {
            await tryLogAuditEntry(
              config.auditLog,
              auditEntry(c, 'admin.session.revoke', 'session', sessionId, 404, { target: userId }),
            );
            return errorResponse(c, 'Session not found', 404);
          }
        }
        await requireAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.session.revoke', 'session', sessionId, 202, {
            target: userId,
            phase: 'before-mutation',
          }),
        );
        try {
          await managedUserProvider.revokeSession(sessionId, getManagedUserScope(c));
        } catch (err) {
          await tryLogAuditEntry(
            config.auditLog,
            auditEntry(c, 'admin.session.revoke', 'session', sessionId, 500, {
              target: userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }
        await tryLogAuditEntry(
          config.auditLog,
          auditEntry(c, 'admin.session.revoke', 'session', sessionId, 200, { target: userId }),
        );
        return c.json({ message: 'Session revoked' }, 200);
      }),
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
      if (query.userId && principal.tenantId) {
        const scopedUser = await managedUserProvider.getUser(query.userId, {
          tenantId: principal.tenantId,
        });
        if (!scopedUser) return errorResponse(c, 'User not found', 404);
      }
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
        params: UserIdParam,
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
