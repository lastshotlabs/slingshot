import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  OrchestrationError,
  type OrchestrationRuntime,
  type RunFilter,
  type RunOptions,
  type RunStatus,
} from '@lastshotlabs/slingshot-orchestration';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorTenantId } from '@lastshotlabs/slingshot-core';

const VALID_STATUSES = new Set<RunStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

function getTenantId(c: Context<AppEnv>): string | undefined {
  return getActorTenantId(c) ?? undefined;
}

function parseRunOptions(body: Record<string, unknown>, tenantId?: string): RunOptions {
  const opts: RunOptions = { tenantId };

  if (typeof body['idempotencyKey'] === 'string' && body['idempotencyKey'].length > 0) {
    opts.idempotencyKey = body['idempotencyKey'] as string;
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
  routeMiddleware: MiddlewareHandler[];
  tasks: AnyResolvedTask[];
  workflows: AnyResolvedWorkflow[];
}) {
  const router = new Hono();
  router.use('*', ...options.routeMiddleware);

  router.post('/tasks/:name/runs', async c => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const input = body['input'];
    const tenantId = getTenantId(c);
    try {
      const handle = await options.runtime.runTask(
        c.req.param('name'),
        input,
        parseRunOptions(body, tenantId),
      );
      const run = await options.runtime.getRun(handle.id);
      return c.json(
        {
          id: handle.id,
          status: run?.status ?? 'pending',
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
    const tenantId = getTenantId(c);
    try {
      const handle = await options.runtime.runWorkflow(
        c.req.param('name'),
        input,
        parseRunOptions(body, tenantId),
      );
      const run = await options.runtime.getRun(handle.id);
      return c.json(
        {
          id: handle.id,
          status: run?.status ?? 'pending',
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
      const run = await options.runtime.getRun(c.req.param('id'));
      if (!run) {
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
      const run = await options.runtime.getRun(c.req.param('id'));
      if (!run) {
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
      const tenantId = getTenantId(c);
      return c.json(
        await options.runtime.listRuns(parseListRunsQuery(new URL(c.req.url), tenantId)),
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

  router.post('/runs/:id/signal/:signalName', async c => {
    if (!options.runtime.supports('signals')) {
      return c.json(
        { error: 'Adapter does not support signals', code: 'CAPABILITY_NOT_SUPPORTED' },
        501,
      );
    }
    try {
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
