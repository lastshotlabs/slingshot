import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorTenantId } from '@lastshotlabs/slingshot-core';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  OrchestrationError,
  type OrchestrationRuntime,
  type Run,
  type RunFilter,
  type RunOptions,
  type RunStatus,
  type WorkflowRun,
} from '@lastshotlabs/slingshot-orchestration';
import type {
  OrchestrationRequestContext,
  OrchestrationRequestContextResolver,
  OrchestrationRunAuthorizer,
} from './types';

const VALID_STATUSES = new Set<RunStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

function defaultRequestContext(c: Context): OrchestrationRequestContext {
  return {
    tenantId: getActorTenantId(c as Context<AppEnv>) ?? undefined,
  };
}

function defaultAuthorizeRun({
  context,
  run,
}: {
  context: OrchestrationRequestContext;
  run: { tenantId?: string };
}): boolean {
  if (!run.tenantId) {
    return true;
  }

  return run.tenantId === context.tenantId;
}

function parseRunOptions(
  body: Record<string, unknown>,
  requestContext: OrchestrationRequestContext,
  c: Context,
): RunOptions {
  const opts: RunOptions = { tenantId: requestContext.tenantId };

  const headerIdempotencyKey = c.req.header('idempotency-key');
  if (typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].length > 0) {
    opts.idempotencyKey = body['idempotencyKey'] as string;
  } else if (typeof headerIdempotencyKey === 'string' && headerIdempotencyKey.length > 0) {
    opts.idempotencyKey = headerIdempotencyKey;
  }
  if (typeof body['delay'] === 'number' && Number.isFinite(body['delay']) && body['delay'] >= 0) {
    opts.delay = Math.trunc(body['delay'] as number);
  }
  if (typeof body['priority'] === 'number' && Number.isFinite(body['priority'])) {
    const priority = body['priority'] as number;
    opts.priority = Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(priority)));
  }
  if (body['tags'] && typeof body['tags'] === 'object' && !Array.isArray(body['tags'])) {
    const tags = body['tags'] as Record<string, unknown>;
    const validated: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of Object.entries(tags)) {
      if (typeof value !== 'string') continue;
      if (count >= 50) break;
      validated[key.slice(0, 256)] = value.slice(0, 1024);
      count += 1;
    }
    opts.tags = validated;
  }
  if (
    body['metadata'] &&
    typeof body['metadata'] === 'object' &&
    !Array.isArray(body['metadata'])
  ) {
    opts.metadata = body['metadata'] as Record<string, unknown>;
  }
  if (
    body['adapterHints'] &&
    typeof body['adapterHints'] === 'object' &&
    !Array.isArray(body['adapterHints'])
  ) {
    opts.adapterHints = body['adapterHints'] as Record<string, unknown>;
  }

  if (requestContext.tags) {
    opts.tags = {
      ...(opts.tags ?? {}),
      ...requestContext.tags,
    };
  }

  const resolvedMetadata: Record<string, unknown> = {
    ...(opts.metadata ?? {}),
    ...(requestContext.metadata ?? {}),
  };
  if (requestContext.actorId) {
    resolvedMetadata['actorId'] = requestContext.actorId;
  }
  if (Object.keys(resolvedMetadata).length > 0) {
    opts.metadata = resolvedMetadata;
  }

  return opts;
}

function parseListRunsQuery(url: URL, tenantId?: string): RunFilter {
  const rawStatuses = url.searchParams.getAll('status').filter(Boolean);
  const statuses = rawStatuses.filter(s => VALID_STATUSES.has(s as RunStatus)) as RunStatus[];
  const rawLimit = url.searchParams.get('limit');
  const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit ? Math.max(1, Math.min(1000, Math.trunc(Number(rawLimit)))) : undefined;
  const offset = rawOffset ? Math.max(0, Math.trunc(Number(rawOffset))) : undefined;

  return {
    type:
      url.searchParams.get('type') === 'task' || url.searchParams.get('type') === 'workflow'
        ? (url.searchParams.get('type') as 'task' | 'workflow')
        : undefined,
    name: url.searchParams.get('name') ?? undefined,
    status: statuses.length === 0 ? undefined : statuses.length === 1 ? statuses[0] : statuses,
    tenantId,
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  };
}

async function resolveRequestContext(
  c: Context<AppEnv>,
  resolver: OrchestrationRequestContextResolver | undefined,
): Promise<OrchestrationRequestContext> {
  const resolved = (await (resolver ?? defaultRequestContext)(c)) ?? {};
  return {
    tenantId:
      typeof resolved.tenantId === 'string' && resolved.tenantId.length > 0
        ? resolved.tenantId
        : undefined,
    actorId:
      typeof resolved.actorId === 'string' && resolved.actorId.length > 0
        ? resolved.actorId
        : undefined,
    tags: resolved.tags,
    metadata: resolved.metadata,
  };
}

function buildRunLink(c: Context<AppEnv>, runId: string): string {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(
    /\/(?:tasks|workflows)\/[^/]+\/runs$/,
    `/runs/${encodeURIComponent(runId)}`,
  );
  url.search = '';
  return `${url.pathname}${url.search}${url.hash}`;
}

async function canAccessRun(
  c: Context<AppEnv>,
  run: Run | WorkflowRun,
  requestContext: OrchestrationRequestContext,
  action: 'read' | 'cancel' | 'signal' | 'list',
  authorizeRun: OrchestrationRunAuthorizer | undefined,
): Promise<boolean> {
  if (authorizeRun) {
    return await authorizeRun({
      action,
      context: requestContext,
      run,
      request: c,
    });
  }

  return defaultAuthorizeRun({ context: requestContext, run });
}

async function listAuthorizedRuns(
  c: Context<AppEnv>,
  runtime: OrchestrationRuntime,
  filter: RunFilter,
  requestContext: OrchestrationRequestContext,
  authorizeRun: OrchestrationRunAuthorizer | undefined,
): Promise<{ runs: Array<Run | WorkflowRun>; total: number }> {
  if (!authorizeRun && !requestContext.tenantId) {
    return runtime.listRuns(filter);
  }

  const requestedOffset = filter.offset ?? 0;
  const requestedLimit = filter.limit ?? 50;
  const batchSize = Math.min(Math.max(requestedLimit * 2, 50), 200);
  const baseFilter: RunFilter = {
    ...filter,
    ...(authorizeRun || !requestContext.tenantId ? {} : { tenantId: undefined }),
    offset: 0,
    limit: batchSize,
  };

  const authorizedRuns: Array<Run | WorkflowRun> = [];
  let authorizedTotal = 0;
  let scanOffset = 0;

  while (true) {
    const page = await runtime.listRuns({
      ...baseFilter,
      offset: scanOffset,
    });
    if (page.runs.length === 0) {
      break;
    }

    for (const run of page.runs) {
      if (!(await canAccessRun(c, run, requestContext, 'list', authorizeRun))) {
        continue;
      }
      if (authorizedTotal >= requestedOffset && authorizedRuns.length < requestedLimit) {
        authorizedRuns.push(run);
      }
      authorizedTotal += 1;
    }

    scanOffset += page.runs.length;
    if (scanOffset >= page.total) {
      break;
    }
  }

  return {
    runs: authorizedRuns,
    total: authorizedTotal,
  };
}

function mapErrorToStatus(error: unknown): 400 | 404 | 500 {
  if (error instanceof OrchestrationError) {
    switch (error.code) {
      case 'INVALID_CONFIG':
      case 'VALIDATION_FAILED':
        return 400;
      case 'TASK_NOT_FOUND':
      case 'WORKFLOW_NOT_FOUND':
      case 'RUN_NOT_FOUND':
        return 404;
      default:
        return 500;
    }
  }
  return 500;
}

/**
 * Build the Hono router that exposes orchestration runs over HTTP.
 */
export function createOrchestrationRouter(options: {
  runtime: OrchestrationRuntime;
  routeMiddleware?: MiddlewareHandler[];
  tasks: AnyResolvedTask[];
  workflows: AnyResolvedWorkflow[];
  resolveRequestContext?: OrchestrationRequestContextResolver;
  authorizeRun?: OrchestrationRunAuthorizer;
}) {
  const router = new Hono<AppEnv>();
  if ((options.routeMiddleware ?? []).length > 0) {
    router.use('*', ...(options.routeMiddleware ?? []));
  }

  router.get('/tasks', c =>
    c.json(
      options.tasks.map(task => ({
        name: task.name,
        description: task.description ?? null,
      })),
      200,
    ),
  );

  router.get('/workflows', c =>
    c.json(
      options.workflows.map(workflow => ({
        name: workflow.name,
        description: workflow.description ?? null,
      })),
      200,
    ),
  );

  router.post('/tasks/:name/runs', async c => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const input = body['input'];
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const handle = await options.runtime.runTask(
        c.req.param('name'),
        input,
        parseRunOptions(body, requestContext, c),
      );
      const run = await options.runtime.getRun(handle.id);
      return c.json(
        {
          id: handle.id,
          type: 'task',
          name: c.req.param('name'),
          status: run?.status ?? 'pending',
          links: {
            run: buildRunLink(c, handle.id),
          },
        },
        202,
      );
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(
        {
          error:
            error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
          code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
        },
        status,
      );
    }
  });

  router.post('/workflows/:name/runs', async c => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const input = body['input'];
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const handle = await options.runtime.runWorkflow(
        c.req.param('name'),
        input,
        parseRunOptions(body, requestContext, c),
      );
      const run = await options.runtime.getRun(handle.id);
      return c.json(
        {
          id: handle.id,
          type: 'workflow',
          name: c.req.param('name'),
          status: run?.status ?? 'pending',
          links: {
            run: buildRunLink(c, handle.id),
          },
        },
        202,
      );
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(
        {
          error:
            error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
          code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
        },
        status,
      );
    }
  });

  router.get('/runs/:id', async c => {
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const run = await options.runtime.getRun(c.req.param('id'));
      if (!run || !(await canAccessRun(c, run, requestContext, 'read', options.authorizeRun))) {
        return c.json(
          { error: `Run '${c.req.param('id')}' not found`, code: 'RUN_NOT_FOUND' },
          404,
        );
      }
      return c.json(run, 200);
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(
        {
          error:
            error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
          code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
        },
        status,
      );
    }
  });

  router.delete('/runs/:id', async c => {
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const run = await options.runtime.getRun(c.req.param('id'));
      if (!run || !(await canAccessRun(c, run, requestContext, 'cancel', options.authorizeRun))) {
        return c.json(
          { error: `Run '${c.req.param('id')}' not found`, code: 'RUN_NOT_FOUND' },
          404,
        );
      }
      await options.runtime.cancelRun(c.req.param('id'));
      return c.body(null, 204);
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(
        {
          error:
            error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
          code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
        },
        status,
      );
    }
  });

  router.get('/runs', async c => {
    if (!options.runtime.supports('observability')) {
      return c.json(
        { error: 'Adapter does not support run listing', code: 'CAPABILITY_NOT_SUPPORTED' },
        501,
      );
    }
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const listed = await listAuthorizedRuns(
        c,
        options.runtime,
        parseListRunsQuery(new URL(c.req.url), requestContext.tenantId),
        requestContext,
        options.authorizeRun,
      );
      return c.json(listed);
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(
        {
          error:
            error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
          code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
        },
        status,
      );
    }
  });

  router.post('/runs/:id/signal/:signalName', async c => {
    if (!options.runtime.supports('signals')) {
      return c.json(
        { error: 'Adapter does not support signals', code: 'CAPABILITY_NOT_SUPPORTED' },
        501,
      );
    }
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const run = await options.runtime.getRun(c.req.param('id'));
      if (!run || !(await canAccessRun(c, run, requestContext, 'signal', options.authorizeRun))) {
        return c.json(
          { error: `Run '${c.req.param('id')}' not found`, code: 'RUN_NOT_FOUND' },
          404,
        );
      }
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      await options.runtime.signal(c.req.param('id'), c.req.param('signalName'), body['payload']);
      return c.json({ status: 'accepted' }, 202);
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(
        {
          error:
            error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
          code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
        },
        status,
      );
    }
  });

  return router;
}
