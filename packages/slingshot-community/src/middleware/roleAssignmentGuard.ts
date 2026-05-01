import type { MiddlewareHandler } from 'hono';
import type { PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';

type RoleAssignmentInput = {
  containerId?: unknown;
  role?: unknown;
};

function isRecord(value: unknown): value is RoleAssignmentInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function subjectType(kind: string): 'user' | 'service-account' {
  return kind === 'user' ? 'user' : 'service-account';
}

/**
 * Enforce the stronger owner-management permission only for owner promotions.
 */
export function createRoleAssignmentGuardMiddleware(deps: {
  evaluator: PermissionEvaluator;
}): MiddlewareHandler {
  return async (c, next) => {
    const actor = getActor(c);
    if (!actor.id) return c.json({ error: 'Unauthorized' }, 401);

    let body: RoleAssignmentInput;
    try {
      const raw = (await c.req.json()) as unknown;
      if (!isRecord(raw)) return c.json({ error: 'Invalid JSON body' }, 400);
      body = raw;
    } catch {
      // Body is not valid JSON; reject with 400
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (body.role !== 'owner') {
      return next();
    }
    if (typeof body.containerId !== 'string' || body.containerId.length === 0) {
      return c.json({ error: 'containerId is required' }, 400);
    }

    const allowed = await deps.evaluator.can(
      { subjectId: actor.id, subjectType: subjectType(actor.kind) },
      'community:container.manage-owners',
      { resourceType: 'community:container', resourceId: body.containerId },
    );
    if (!allowed) return c.json({ error: 'Forbidden' }, 403);

    await next();
  };
}
