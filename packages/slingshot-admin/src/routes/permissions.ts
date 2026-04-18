import type { Context } from 'hono';
import { z } from 'zod';
import { createRoute, errorResponse, validateGrant } from '@lastshotlabs/slingshot-core';
import type {
  AdminPrincipal,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
  SubjectType,
} from '@lastshotlabs/slingshot-core';
import { createTypedRouter, registerRoute } from '../lib/typedRoute';
import type { AdminEnv } from '../types/env';

export interface PermissionsRouterConfig {
  evaluator: PermissionEvaluator;
  adapter: PermissionsAdapter;
  registry: PermissionRegistry;
}

const tags = ['Admin Permissions'];

const ErrorResponse = z.object({ error: z.string() });

const GrantBody = z.object({
  subjectId: z.string(),
  subjectType: z.enum(['user', 'group', 'service-account']),
  tenantId: z.string().nullable().optional(),
  resourceType: z.string().nullable().optional(),
  resourceId: z.string().nullable().optional(),
  roles: z.array(z.string()).min(1),
  effect: z.enum(['allow', 'deny']).optional().default('allow'),
  reason: z.string().optional(),
  expiresAt: z.string().optional(), // ISO string — parse to Date before validateGrant
});

const GrantResponse = z
  .object({
    id: z.string(),
  })
  .openapi('PermissionGrantCreated');

const GrantRecord = z
  .object({
    id: z.string(),
    subjectId: z.string(),
    subjectType: z.string(),
    tenantId: z.string().nullable(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    roles: z.array(z.string()),
    effect: z.string(),
    grantedBy: z.string(),
    grantedAt: z.string(),
    reason: z.string().optional(),
    expiresAt: z.string().optional(),
    revokedBy: z.string().optional(),
    revokedAt: z.string().optional(),
  })
  .openapi('PermissionGrant');

const GrantListResponse = z
  .object({
    grants: z.array(GrantRecord),
  })
  .openapi('PermissionGrantList');

const ResourceTypeRecord = z
  .object({
    resourceType: z.string(),
    actions: z.array(z.string()),
    roles: z.record(z.string(), z.array(z.string())),
  })
  .openapi('ResourceTypeDefinition');

const ResourceTypeListResponse = z
  .object({
    resourceTypes: z.array(ResourceTypeRecord),
  })
  .openapi('ResourceTypeList');

// Tenant scope enforcement helper.
// Returns an error response if principal cannot access the target tenant, or null if allowed.
function assertPermissionsScope(
  c: Context<AdminEnv>,
  principal: AdminPrincipal,
  targetTenantId: string | null,
): Response | null {
  // principal.tenantId === undefined means global admin (same as null)
  const principalTenant = principal.tenantId ?? null;
  if (principalTenant !== null && targetTenantId !== principalTenant) {
    return errorResponse(c, 'Cross-tenant permission access denied', 403);
  }
  return null;
}

// Permission check — returns false if denied; callers must handle the false case.
async function checkPerm(
  c: Context<AdminEnv>,
  evaluator: PermissionEvaluator,
  action: string,
): Promise<boolean> {
  const principal = c.get('adminPrincipal');
  return evaluator.can({ subjectId: principal.subject, subjectType: 'user' }, action, {
    tenantId: principal.tenantId,
    resourceType: 'admin:permission',
  });
}

export function createPermissionsRouter(config: PermissionsRouterConfig) {
  const { evaluator, adapter, registry } = config;
  const router = createTypedRouter();

  // POST /grants — create a grant
  registerRoute(
    router,
    createRoute({
      method: 'post',
      path: '/grants',
      summary: 'Create a permission grant',
      tags,
      request: {
        body: { content: { 'application/json': { schema: GrantBody } } },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: GrantResponse } },
          description: 'Grant created.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid grant shape.',
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
      if (!(await checkPerm(c, evaluator, 'write'))) return errorResponse(c, 'Forbidden', 403);
      const principal = c.get('adminPrincipal');
      const body = GrantBody.parse(await c.req.json());

      const targetTenantId = body.tenantId ?? null;
      const principalTenant = principal.tenantId ?? null;

      // Tenant scope enforcement
      const scopeError = assertPermissionsScope(c, principal, targetTenantId);
      if (scopeError) return scopeError;

      // Only global admins may create global (tenantId=null) grants
      if (targetTenantId === null && principalTenant !== null) {
        return errorResponse(c, 'Only global admins may create global grants', 403);
      }

      // Only global admins may grant super-admin
      if (body.roles.includes('super-admin') && principalTenant !== null) {
        return errorResponse(c, 'Only global admins may grant super-admin', 403);
      }

      // Parse expiresAt string to Date BEFORE calling validateGrant
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;

      try {
        const grantInput = {
          subjectId: body.subjectId,
          subjectType: body.subjectType,
          tenantId: targetTenantId,
          resourceType: body.resourceType ?? null,
          resourceId: body.resourceId ?? null,
          roles: body.roles,
          effect: body.effect,
          grantedBy: principal.subject, // never from client
          reason: body.reason,
          expiresAt,
        };
        // validateGrant is also called inside createGrant, but call here for early error
        validateGrant(grantInput);
        const id = await adapter.createGrant(grantInput);
        return c.json({ id }, 201);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Invalid grant';
        return errorResponse(c, message, 400);
      }
    },
  );

  // DELETE /grants/:grantId — revoke a grant
  registerRoute(
    router,
    createRoute({
      method: 'delete',
      path: '/grants/:grantId',
      summary: 'Revoke a permission grant',
      tags,
      request: {
        params: z.object({ grantId: z.string() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ message: z.string() }) } },
          description: 'Grant revoked.',
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
          description: 'Grant not found.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      if (!(await checkPerm(c, evaluator, 'write'))) return errorResponse(c, 'Forbidden', 403);
      const principal = c.get('adminPrincipal');
      const grantId = c.req.param('grantId') ?? '';
      const principalTenant = principal.tenantId ?? null;

      const revoked = await adapter.revokeGrant(
        grantId,
        principal.subject,
        principalTenant !== null ? principalTenant : undefined,
      );
      if (!revoked) return errorResponse(c, 'Grant not found', 404);
      return c.json({ message: 'Grant revoked' }, 200);
    },
  );

  // GET /subjects/:subjectType/:subjectId/grants
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/subjects/:subjectType/:subjectId/grants',
      summary: 'List grants for a subject',
      tags,
      request: {
        params: z.object({
          subjectType: z.enum(['user', 'group', 'service-account']),
          subjectId: z.string(),
        }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: GrantListResponse } },
          description: 'Grant list.',
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
      if (!(await checkPerm(c, evaluator, 'read'))) return errorResponse(c, 'Forbidden', 403);
      const principal = c.get('adminPrincipal');
      const subjectType = (c.req.param('subjectType') ?? '') as SubjectType;
      const subjectId = c.req.param('subjectId') ?? '';
      const principalTenant = principal.tenantId ?? null;

      let grants = await adapter.getGrantsForSubject(subjectId, subjectType);

      // Non-global callers: filter to their tenant only
      if (principalTenant !== null) {
        grants = grants.filter(g => g.tenantId === principalTenant);
      }

      return c.json(
        {
          grants: grants.map(g => ({
            ...g,
            grantedAt: g.grantedAt.toISOString(),
            expiresAt: g.expiresAt?.toISOString(),
            revokedAt: g.revokedAt?.toISOString(),
          })),
        },
        200,
      );
    },
  );

  // GET /resources/:type/:id/grants
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/resources/:type/:id/grants',
      summary: 'List grants on a resource',
      tags,
      request: {
        params: z.object({ type: z.string(), id: z.string() }),
        query: z.object({ tenantId: z.string().optional() }),
      },
      responses: {
        200: {
          content: { 'application/json': { schema: GrantListResponse } },
          description: 'Grant list.',
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
      if (!(await checkPerm(c, evaluator, 'read'))) return errorResponse(c, 'Forbidden', 403);
      const principal = c.get('adminPrincipal');
      const type = c.req.param('type') ?? '';
      const id = c.req.param('id') ?? '';
      const tenantIdQuery = c.req.query('tenantId');
      const principalTenant = principal.tenantId ?? null;

      // tenantId=undefined or 'global' means global grants
      const targetTenantId =
        tenantIdQuery === 'global' || tenantIdQuery === undefined ? null : tenantIdQuery;

      // Global grant queries require global admin
      if (targetTenantId === null && principalTenant !== null) {
        return errorResponse(c, 'Only global admins may query global grants', 403);
      }

      // Tenant-scoped caller cannot query other tenants
      if (
        targetTenantId !== null &&
        principalTenant !== null &&
        targetTenantId !== principalTenant
      ) {
        return errorResponse(c, 'Cross-tenant permission access denied', 403);
      }

      const grants = await adapter.listGrantsOnResource(type, id, targetTenantId);
      return c.json(
        {
          grants: grants.map(g => ({
            ...g,
            grantedAt: g.grantedAt.toISOString(),
            expiresAt: g.expiresAt?.toISOString(),
            revokedAt: g.revokedAt?.toISOString(),
          })),
        },
        200,
      );
    },
  );

  // GET /resources — list registered resource types
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/resources',
      summary: 'List registered resource types',
      tags,
      responses: {
        200: {
          content: { 'application/json': { schema: ResourceTypeListResponse } },
          description: 'Resource types.',
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
      if (!(await checkPerm(c, evaluator, 'read'))) return errorResponse(c, 'Forbidden', 403);
      const resourceTypes = registry.listResourceTypes();
      return c.json({ resourceTypes }, 200);
    },
  );

  return router;
}
