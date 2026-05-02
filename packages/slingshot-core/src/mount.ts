import { createRoute } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { getActor, getRequestTenantId } from './actorContext';
import type { AppEnv } from './context';
import { getSlingshotCtx } from './context';
import type { SlingshotHandler } from './handler';
import { type GuardWithMetadata, HandlerError, type HandlerMeta } from './handler';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';

export interface RouteOpts {
  method: RouteMethod;
  path: string;
  tags?: string[];
  summary?: string;
  successStatus?: number;
  params?: import('zod').ZodType<unknown>;
}

async function runHttpAuthGuard(
  middleware: MiddlewareHandler<AppEnv>,
  c: Context<AppEnv>,
): Promise<void> {
  let nextCalled = false;
  const result = await middleware(c, () => {
    nextCalled = true;
    return Promise.resolve();
  });

  if (!nextCalled) {
    throw new HandlerError('Unauthorized', {
      status: result instanceof Response ? result.status : c.res.status,
      details:
        result instanceof Response
          ? undefined
          : {
              body: c.res,
            },
    });
  }
}

function readClientIp(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? null;
  }
  return c.req.header('x-real-ip') ?? null;
}

async function runTransportAuthPreflight(
  handler: SlingshotHandler,
  c: Context<AppEnv>,
): Promise<void> {
  const ctx = getSlingshotCtx(c);
  for (const guard of handler.guards) {
    const metadata = guard as GuardWithMetadata;
    if (metadata._httpAuth === 'userAuth') {
      if (!ctx.routeAuth) {
        throw new HandlerError('Auth not configured', { status: 500 });
      }
      await runHttpAuthGuard(ctx.routeAuth.userAuth, c);
    }
    if (metadata._httpAuth === 'bearer') {
      if (!ctx.routeAuth?.bearerAuth) {
        throw new HandlerError('Bearer auth not configured', { status: 500 });
      }
      await runHttpAuthGuard(ctx.routeAuth.bearerAuth, c);
    }
  }
}

/**
 * Create an OpenAPI route declaration from a {@link SlingshotHandler}.
 *
 * Maps the handler's `input` schema to either a request body (POST/PUT/PATCH) or
 * query parameters (GET/DELETE/HEAD), and builds a standard response map including
 * the configured success status code.
 *
 * @param handler - The handler whose input/output schemas define the route contract.
 * @param opts - Method, path, tags, summary, optional params schema, and success status override.
 * @returns A `@hono/zod-openapi` route definition ready for `app.openapi()`.
 */
export function toRoute(handler: SlingshotHandler, opts: RouteOpts) {
  const successStatus = opts.successStatus ?? (opts.method === 'post' ? 201 : 200);
  const request: Record<string, unknown> = {};

  if (opts.params) {
    request.params = opts.params;
  }

  if (opts.method === 'post' || opts.method === 'put' || opts.method === 'patch') {
    request.body = {
      content: { 'application/json': { schema: handler.input } },
    };
  } else {
    request.query = handler.input;
  }

  return createRoute({
    method: opts.method,
    path: opts.path,
    tags: opts.tags,
    summary: opts.summary ?? handler.name,
    ...(Object.keys(request).length > 0 ? { request } : {}),
    responses: {
      [successStatus]: {
        description: 'Success',
        content: { 'application/json': { schema: handler.output } },
      },
      400: { description: 'Bad request' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
      404: { description: 'Not found' },
      409: { description: 'Conflict' },
      429: { description: 'Too many requests' },
      500: { description: 'Internal server error' },
    },
  });
}

/**
 * Create a Hono route handler that invokes a {@link SlingshotHandler}.
 *
 * Runs transport-level auth preflight (userAuth / bearer guards), parses the JSON body
 * for write methods, merges query params + body + path params into a single input object,
 * constructs {@link HandlerMeta} with request context (actor, tenant, IP, idempotency key),
 * and delegates to `handler.invoke()`. Returns 204 for null/undefined output or when
 * `successStatus` is 204.
 *
 * @param handler - The handler to wrap.
 * @param opts - Optional method and success status overrides.
 * @returns An async Hono handler function.
 */
export function toRouteHandler(
  handler: SlingshotHandler,
  opts?: Pick<RouteOpts, 'successStatus' | 'method'>,
): (c: Context<AppEnv>) => Promise<Response> {
  const successStatus = opts?.successStatus ?? (opts?.method === 'post' ? 201 : 200);

  return async (c: Context<AppEnv>) => {
    await runTransportAuthPreflight(handler, c);

    let body: Record<string, unknown> = {};
    if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
      try {
        const parsed = (await c.req.json()) as unknown;
        if (parsed && typeof parsed === 'object') {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid or empty JSON body — downstream Zod validation will reject if fields are required
        body = {};
      }
    }

    const raw = {
      ...Object.fromEntries(new URL(c.req.url).searchParams.entries()),
      ...body,
      ...(c.req.param() as Record<string, string>),
    };

    const actor = getActor(c);

    const meta: Partial<HandlerMeta> = {
      requestId: c.get('requestId'),
      actor,
      requestTenantId: getRequestTenantId(c),
      correlationId: c.get('requestId'),
      ip: readClientIp(c),
      idempotencyKey: c.req.header('idempotency-key') ?? undefined,
    };

    const output = await handler.invoke(raw, { ctx: getSlingshotCtx(c), meta });

    if (successStatus === 204 || output === null || output === undefined) {
      return c.body(null, 204);
    }

    return c.json(output, successStatus as never);
  };
}

/**
 * Mount a `SlingshotHandler` on an OpenAPI-capable Hono app.
 */
export function mount(
  app: {
    openapi(
      route: ReturnType<typeof createRoute>,
      handler: (c: Context<AppEnv>) => Promise<Response>,
    ): unknown;
  },
  handler: SlingshotHandler,
  opts: RouteOpts,
): void {
  app.openapi(toRoute(handler, opts), toRouteHandler(handler, opts));
}
