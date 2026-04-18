import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import type {
  PermissionEvaluator,
  RouteAuthRegistry,
  RouteOperationConfig,
} from '@lastshotlabs/slingshot-core';

/**
 * Result of evaluating auth and permission requirements for an entity route.
 */
export interface RouteAuthResult {
  /** Whether the request is authorized to continue. */
  readonly authorized: boolean;
  /** Response to return immediately when authorization fails. */
  readonly response?: Response;
}

/**
 * Runtime dependencies required to evaluate route auth.
 */
export interface EvaluateRouteAuthDeps {
  /** Route-auth middleware registry provided by the auth plugin. */
  readonly routeAuth?: RouteAuthRegistry | null;
  /** Permission evaluator used when the route declares `permission`. */
  readonly permissionEvaluator?: PermissionEvaluator;
  /** Entity adapter used for `record:` scope resolution and owner checks. */
  readonly adapter?: { getById(id: string): Promise<unknown> };
  /** Parent adapter used for `parentAuth` checks. */
  readonly parentAdapter?: { getById(id: string): Promise<unknown> };
}

function resolveDotPath(obj: unknown, path: string): string | undefined {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  if (current === null || current === undefined) return undefined;
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  return undefined;
}

async function runAuthMiddleware(
  middleware: MiddlewareHandler<AppEnv>,
  c: Context<AppEnv, string>,
): Promise<RouteAuthResult> {
  const state = { nextCalled: false };

  const result = await middleware(c, () => {
    state.nextCalled = true;
    return Promise.resolve();
  });

  if (state.nextCalled) {
    return { authorized: true };
  }

  return {
    authorized: false,
    response: result instanceof Response ? result : c.res,
  };
}

/**
 * Evaluate auth and permission requirements for a route operation.
 *
 * Shared between generated entity API routes and entity-driven SSR pages so
 * both surfaces enforce the same auth, parent-auth, and permission behavior.
 *
 * @param c - Active Hono request context.
 * @param operationConfig - Merged operation config for the current route.
 * @param deps - Runtime auth and adapter dependencies.
 * @returns Authorization result and an optional blocking response.
 */
export async function evaluateRouteAuth(
  c: Context<AppEnv, string>,
  operationConfig: RouteOperationConfig | undefined,
  deps: EvaluateRouteAuthDeps,
): Promise<RouteAuthResult> {
  if (!operationConfig) {
    return { authorized: true };
  }

  if (operationConfig.auth === 'userAuth') {
    if (!deps.routeAuth) {
      return {
        authorized: false,
        response: c.json({ error: 'Auth not configured' }, 500),
      };
    }

    const authResult = await runAuthMiddleware(deps.routeAuth.userAuth, c);
    if (!authResult.authorized) return authResult;
  } else if (operationConfig.auth === 'bearer') {
    if (!deps.routeAuth) {
      return {
        authorized: false,
        response: c.json({ error: 'Auth not configured' }, 500),
      };
    }

    if (!deps.routeAuth.bearerAuth) {
      return {
        authorized: false,
        response: c.json({ error: 'Bearer auth not configured' }, 500),
      };
    }

    const authResult = await runAuthMiddleware(deps.routeAuth.bearerAuth, c);
    if (!authResult.authorized) return authResult;
  }

  const permission = operationConfig.permission;
  if (!permission) {
    return { authorized: true };
  }

  if (permission.parentAuth && deps.parentAdapter) {
    const parentId = c.req.param(permission.parentAuth.idParam);
    if (!parentId) {
      return {
        authorized: false,
        response: c.json({ error: 'Not found' }, 404),
      };
    }

    const parent = (await deps.parentAdapter.getById(parentId)) as Record<string, unknown> | null;
    const tenantId = c.get('tenantId' as never) as string | undefined;
    if (!parent || parent[permission.parentAuth.tenantField] !== tenantId) {
      return {
        authorized: false,
        response: c.json({ error: 'Not found' }, 404),
      };
    }
  }

  if (!deps.permissionEvaluator) {
    return { authorized: true };
  }

  const subjectId = c.get('authUserId' as never) as string | undefined;
  if (!subjectId) {
    return {
      authorized: false,
      response: c.json({ error: 'Forbidden' }, 403),
    };
  }

  const scope: Record<string, string | undefined> = {
    tenantId: c.get('tenantId' as never) as string | undefined,
  };

  let entityRecord: Record<string, unknown> | null | undefined;
  const scopeEntries = Object.entries(permission.scope ?? {});

  let parsedBody: unknown;
  if (scopeEntries.some(([, value]) => value.startsWith('body:'))) {
    try {
      parsedBody = await c.req.json();
    } catch {
      return {
        authorized: false,
        response: c.json({ error: 'Bad request' }, 400),
      };
    }
  }

  if (
    deps.adapter &&
    (permission.ownerField !== undefined ||
      scopeEntries.some(([, value]) => value.startsWith('record:')))
  ) {
    const id = c.req.param('id');
    if (!id) {
      return {
        authorized: false,
        response: c.json({ error: 'Not found' }, 404),
      };
    }

    entityRecord = (await deps.adapter.getById(id)) as Record<string, unknown> | null;
    if (!entityRecord) {
      return {
        authorized: false,
        response: c.json({ error: 'Not found' }, 404),
      };
    }
  }

  for (const [key, value] of scopeEntries) {
    if (value.startsWith('param:')) {
      scope[key] = c.req.param(value.slice(6));
    } else if (value.startsWith('body:')) {
      scope[key] = resolveDotPath(parsedBody, value.slice(5));
    } else if (value.startsWith('record:')) {
      scope[key] = resolveDotPath(entityRecord, value.slice(7));
    } else if (value.startsWith('query:')) {
      scope[key] = c.req.query(value.slice(6));
    } else {
      scope[key] = value;
    }
  }

  const subject = {
    subjectId,
    subjectType: 'user' as const,
  };

  let allowed = await deps.permissionEvaluator.can(subject, permission.requires, scope);
  if (!allowed && permission.or) {
    allowed = await deps.permissionEvaluator.can(subject, permission.or, scope);
  }

  if (!allowed && permission.ownerField && entityRecord) {
    allowed = entityRecord[permission.ownerField] === subjectId;
  }

  return allowed
    ? { authorized: true }
    : {
        authorized: false,
        response: c.json({ error: 'Forbidden' }, 403),
      };
}
