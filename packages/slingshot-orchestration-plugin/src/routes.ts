import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, HealthCheck, HealthReport } from '@lastshotlabs/slingshot-core';
import { TimeoutError, getActorTenantId, withTimeout } from '@lastshotlabs/slingshot-core';
import {
  type AnyResolvedTask,
  type AnyResolvedWorkflow,
  type OrchestrationAdapter,
  OrchestrationError,
  type OrchestrationRuntime,
  type Run,
  type RunFilter,
  type RunOptions,
  type RunStatus,
  type WorkflowRun,
} from '@lastshotlabs/slingshot-orchestration';
import { InvalidResolverResultError } from './errors';
import type {
  OrchestrationRequestContext,
  OrchestrationRequestContextResolver,
  OrchestrationRunAuthorizer,
} from './types';

const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;

function timeoutErrorBody(err: TimeoutError): {
  error: string;
  code: 'ROUTE_TIMEOUT';
  timeoutMs: number;
} {
  return {
    error: `Adapter call exceeded route timeout (${err.timeoutMs}ms)`,
    code: 'ROUTE_TIMEOUT',
    timeoutMs: err.timeoutMs,
  };
}

// Maximum total records scanned in a single listAuthorizedRuns() call.
// Prevents a malicious or misconfigured authorizeRun filter from scanning
// millions of records per HTTP request when the filter rejects most results.
const MAX_AUTH_SCAN = 2_000;

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
    // Clamp priority to [-1_000_000, 1_000_000] — wide enough for any real ordering
    // scheme while staying safely inside signed 32-bit integer range used by most queue backends.
    opts.priority = Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(priority)));
  }
  if (body['tags'] && typeof body['tags'] === 'object' && !Array.isArray(body['tags'])) {
    const tags = body['tags'] as Record<string, unknown>;
    const validated: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of Object.entries(tags)) {
      if (typeof value !== 'string') continue;
      // 50 entries: matches typical tag-indexing limits in BullMQ/Temporal adapters.
      if (count >= 50) break;
      // 256-char keys and 1024-char values: aligns with common database index column widths.
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

// Sentinel error that signals an invalid resolver result without leaking the
// resolver's identity to callers. Routes catch this and translate it into an
// HTTP 500 with a stable error code so observability tooling can flag the
// misconfiguration distinctly from generic adapter/internal errors.
// (InvalidResolverResultError is imported from './errors')

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveRequestContext(
  c: Context<AppEnv>,
  resolver: OrchestrationRequestContextResolver | undefined,
): Promise<OrchestrationRequestContext> {
  const raw = await (resolver ?? defaultRequestContext)(c);

  // null / undefined are explicitly allowed and treated as an empty context.
  if (raw === null || raw === undefined) {
    return {};
  }

  // Anything that isn't a plain object is a contract violation.
  if (!isPlainObject(raw)) {
    throw new InvalidResolverResultError('expected an object, null, or undefined');
  }
  const resolved = raw as Partial<OrchestrationRequestContext>;

  if (resolved.tenantId !== undefined && typeof resolved.tenantId !== 'string') {
    throw new InvalidResolverResultError('tenantId must be a string when provided');
  }
  if (resolved.actorId !== undefined && typeof resolved.actorId !== 'string') {
    throw new InvalidResolverResultError('actorId must be a string when provided');
  }
  if (resolved.tags !== undefined && !isPlainObject(resolved.tags)) {
    throw new InvalidResolverResultError('tags must be an object when provided');
  }
  if (resolved.metadata !== undefined && !isPlainObject(resolved.metadata)) {
    throw new InvalidResolverResultError('metadata must be an object when provided');
  }

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
  // Cover three URL shapes that can produce a run-link:
  //   POST /tasks/:name/runs
  //   POST /workflows/:name/runs
  //   POST /runs/:id/replay
  // All three should resolve to /runs/<runId> regardless of the originating route.
  if (/\/(?:tasks|workflows)\/[^/]+\/runs$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(
      /\/(?:tasks|workflows)\/[^/]+\/runs$/,
      `/runs/${encodeURIComponent(runId)}`,
    );
  } else if (/\/runs\/[^/]+\/replay$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(
      /\/runs\/[^/]+\/replay$/,
      `/runs/${encodeURIComponent(runId)}`,
    );
  } else {
    // Fallback: append `/runs/<runId>` to the request path so callers always
    // receive a usable absolute path even when the URL shape is unfamiliar.
    url.pathname = `${url.pathname.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}`;
  }
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
  wrap: <T>(p: Promise<T>, label: string) => Promise<T>,
): Promise<{ runs: Array<Run | WorkflowRun>; total: number }> {
  if (!authorizeRun && !requestContext.tenantId) {
    return wrap(runtime.listRuns(filter), 'runtime.listRuns');
  }

  const requestedOffset = filter.offset ?? 0;
  const requestedLimit = filter.limit ?? 50;
  // Cap batch fetch to 2× requested limit (min 50, max 200) to amortize auth filter cost
  // while bounding over-fetch. Larger batches reduce round-trips when the authorizer is
  // selective; smaller batches prevent excessive memory use when limits are large.
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
  let truncated = false;

  while (true) {
    // Stop scanning when we have hit MAX_AUTH_SCAN records — this prevents a single HTTP
    // request from scanning the entire run history when authorizeRun rejects aggressively.
    if (scanOffset >= MAX_AUTH_SCAN) {
      truncated = true;
      break;
    }

    const page = await wrap(
      runtime.listRuns({
        ...baseFilter,
        offset: scanOffset,
      }),
      'runtime.listRuns',
    );
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
    ...(truncated ? { truncated: true } : {}),
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

function buildErrorPayload(error: unknown): { error: string; code: string } {
  if (error instanceof InvalidResolverResultError) {
    return { error: error.message, code: error.code };
  }
  return {
    error: error instanceof OrchestrationError ? error.message : 'Internal orchestration error',
    code: error instanceof OrchestrationError ? error.code : 'ADAPTER_ERROR',
  };
}

function registerAdminRoutes(
  router: Hono<AppEnv>,
  options: {
    adminAuth?: MiddlewareHandler[];
    adapter?: OrchestrationAdapter;
  },
) {
  const admin = new Hono<AppEnv>();
  if ((options.adminAuth ?? []).length > 0) {
    admin.use('*', ...(options.adminAuth ?? []));
  }

  admin.get('/health', async c => {
    const adapter = options.adapter as AdapterWithOps | undefined;
    const adapterName = adapter?.name ?? null;
    const checkHealth = adapter?.checkHealth;
    const getHealth = adapter?.getHealth;
    if (!adapter || (typeof checkHealth !== 'function' && typeof getHealth !== 'function')) {
      // Adapter has not opted into health introspection. Still return 200
      // with adapter identity so the route is usable as a basic liveness probe.
      return c.json({ status: 'ok', adapter: adapterName }, 200);
    }

    if (typeof checkHealth === 'function') {
      let report: HealthReport;
      try {
        report = await checkHealth();
      } catch (error) {
        // The probe itself failed — treat as a permanent (non-retryable)
        // adapter contract bug.
        return c.json(
          {
            status: 'error',
            adapter: adapterName,
            error: error instanceof Error ? error.message : 'unknown adapter health error',
          },
          500,
        );
      }
      const payload: Record<string, unknown> = {
        adapter: adapterName,
        state: report.state,
        message: report.message,
        details: report.details,
        component: report.component,
      };
      if (report.state === 'healthy') {
        return c.json(payload, 200);
      }
      // degraded and unhealthy are transient by the HealthCheck contract.
      c.header('Retry-After', String(HEALTH_RETRY_AFTER_SECONDS));
      return c.json(payload, 503);
    }

    try {
      if (typeof getHealth !== 'function') {
        return c.json({ status: 'ok', adapter: adapterName }, 200);
      }
      const health = await getHealth();
      const payload: Record<string, unknown> = {
        status: typeof health?.status === 'string' ? health.status : 'ok',
        adapter: adapterName,
        ...health,
      };
      return c.json(payload, 200);
    } catch (error) {
      // Legacy getHealth() path: a throw is treated as permanent — adapters that
      // need transient semantics should migrate to checkHealth().
      return c.json(
        {
          status: 'error',
          adapter: adapterName,
          error: error instanceof Error ? error.message : 'unknown adapter health error',
        },
        500,
      );
    }
  });

  admin.get('/metrics', async c => {
    const adapter = options.adapter as AdapterWithOps | undefined;
    if (!adapter || typeof adapter.getMetrics !== 'function') {
      return c.json(
        {
          error: 'Adapter does not expose metrics',
          code: 'CAPABILITY_NOT_SUPPORTED',
        },
        501,
      );
    }
    try {
      const metrics = await adapter.getMetrics();
      return c.json(
        {
          adapter: adapter.name ?? null,
          metrics,
        },
        200,
      );
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'unknown adapter metrics error',
          code: 'ADAPTER_ERROR',
        },
        500,
      );
    }
  });

  router.route('/', admin);
}

/**
 * Optional adapter health snapshot exposed via `GET /health`.
 *
 * Adapters opt in by implementing `getHealth()`; the router treats the method as
 * advisory so adapters that omit it still get a basic `{ status: 'ok' }` response.
 */
export interface OrchestrationAdapterHealth {
  status?: string;
  queues?: unknown;
  droppedMessages?: unknown;
  [key: string]: unknown;
}

/**
 * Optional adapter metrics snapshot exposed via `GET /metrics`.
 *
 * Adapters opt in by implementing `getMetrics()`. When omitted the route returns
 * 501 so callers can discover capability availability without crashing.
 */
export type OrchestrationAdapterMetrics = Record<string, unknown>;

type AdapterWithOps = OrchestrationAdapter & {
  getHealth?: () => Promise<OrchestrationAdapterHealth> | OrchestrationAdapterHealth;
  getMetrics?: () => Promise<OrchestrationAdapterMetrics> | OrchestrationAdapterMetrics;
  /**
   * Optional structured probe matching the framework `HealthCheck` contract. When
   * present the `/health` route uses it to distinguish transient
   * (`degraded`/`unhealthy` -> 503 with `Retry-After`) from permanent
   * (probe throw -> 500) failures.
   */
  checkHealth?: HealthCheck['checkHealth'];
  name?: string;
};

/**
 * Default `Retry-After` header (seconds) returned with 503 responses.
 * Five seconds gives transient adapter blips room to recover without burning a
 * client tight loop.
 */
const HEALTH_RETRY_AFTER_SECONDS = 5;

/**
 * Build the Hono router that exposes orchestration runs over HTTP.
 */
export function createOrchestrationRouter(options: {
  runtime: OrchestrationRuntime;
  routeMiddleware?: MiddlewareHandler[];
  adminAuth?: MiddlewareHandler[];
  tasks: AnyResolvedTask[];
  workflows: AnyResolvedWorkflow[];
  resolveRequestContext?: OrchestrationRequestContextResolver;
  authorizeRun?: OrchestrationRunAuthorizer;
  adapter?: OrchestrationAdapter;
  routeTimeoutMs?: number;
}) {
  const router = new Hono<AppEnv>();
  const routeTimeoutMs = options.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
  const wrap = <T>(promise: Promise<T>, label: string): Promise<T> =>
    withTimeout(promise, routeTimeoutMs, label);
  // Mount admin routes first with their own (optional) auth chain so the
  // wildcard `routeMiddleware` registered below does not also gate /health
  // and /metrics. This lets ops use a different identity (basic auth, IP
  // allowlist, etc.) than user-facing API callers.
  registerAdminRoutes(router, options);
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
    let parseError = false;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // Signal that JSON was malformed so the caller gets a clear 400 error rather
      // than silently treating the body as empty and creating an unintended run.
      parseError = true;
      body = {};
    }
    if (parseError) {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }
    // Reject payloads where metadata serializes above 64 KB — prevents memory spikes
    // and runaway Redis/BullMQ job-data growth from unbounded client payloads.
    // Use Buffer.byteLength so multi-byte UTF-8 sequences (emoji, CJK) are
    // counted by their on-the-wire byte size rather than JS string length.
    if (
      body['metadata'] &&
      typeof body['metadata'] === 'object' &&
      !Array.isArray(body['metadata']) &&
      Buffer.byteLength(JSON.stringify(body['metadata']), 'utf8') > 65_536
    ) {
      return c.json({ error: 'metadata exceeds 64KB limit' }, 400);
    }
    const input = body['input'] !== undefined ? body['input'] : {};
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const handle = await wrap(
        options.runtime.runTask(
          c.req.param('name'),
          input,
          parseRunOptions(body, requestContext, c),
        ),
        'runtime.runTask',
      );
      const run = await wrap(options.runtime.getRun(handle.id), 'runtime.getRun');
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
      if (error instanceof TimeoutError) {
        return c.json(timeoutErrorBody(error), 504);
      }
      const status = mapErrorToStatus(error);
      return c.json(buildErrorPayload(error), status);
    }
  });

  router.post('/workflows/:name/runs', async c => {
    let body: Record<string, unknown>;
    let parseError = false;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      parseError = true;
      body = {};
    }
    if (parseError) {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }
    // Reject payloads where metadata serializes above 64 KB. Use Buffer.byteLength
    // so multi-byte UTF-8 sequences are counted by on-the-wire byte size.
    if (
      body['metadata'] &&
      typeof body['metadata'] === 'object' &&
      !Array.isArray(body['metadata']) &&
      Buffer.byteLength(JSON.stringify(body['metadata']), 'utf8') > 65_536
    ) {
      return c.json({ error: 'metadata exceeds 64KB limit' }, 400);
    }
    const input = body['input'] !== undefined ? body['input'] : {};
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const handle = await wrap(
        options.runtime.runWorkflow(
          c.req.param('name'),
          input,
          parseRunOptions(body, requestContext, c),
        ),
        'runtime.runWorkflow',
      );
      const run = await wrap(options.runtime.getRun(handle.id), 'runtime.getRun');
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
      if (error instanceof TimeoutError) {
        return c.json(timeoutErrorBody(error), 504);
      }
      const status = mapErrorToStatus(error);
      return c.json(buildErrorPayload(error), status);
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
      return c.json(buildErrorPayload(error), status);
    }
  });

  /**
   * Polling-based progress endpoint.
   * Returns only the progress payload for a run, enabling lightweight polling
   * from clients that do not need the full run representation.
   */
  router.get('/runs/:id/progress', async c => {
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const run = await withTimeout(
        options.runtime.getRun(c.req.param('id')),
        routeTimeoutMs,
        `orchestration-routes.getRun(${c.req.param('id')})`,
      );
      if (!run || !(await canAccessRun(c, run, requestContext, 'read', options.authorizeRun))) {
        return c.json(
          { error: `Run '${c.req.param('id')}' not found`, code: 'RUN_NOT_FOUND' },
          404,
        );
      }
      return c.json(
        {
          runId: run.id,
          status: run.status,
          progress: run.progress ?? null,
          type: run.type,
          name: run.name,
        },
        200,
      );
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(buildErrorPayload(error), status);
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
      return c.json(buildErrorPayload(error), status);
    }
  });

  router.post('/runs/:id/replay', async c => {
    const sourceId = c.req.param('id');
    try {
      const requestContext = await resolveRequestContext(c, options.resolveRequestContext);
      const sourceRun = await options.runtime.getRun(sourceId);
      // Authorize replay using `cancel` semantics: replaying a run is a
      // mutating action on the same logical job, so it should follow the same
      // authorization policy as cancel rather than the read-only path.
      if (
        !sourceRun ||
        !(await canAccessRun(c, sourceRun, requestContext, 'cancel', options.authorizeRun))
      ) {
        return c.json({ error: `Run '${sourceId}' not found`, code: 'RUN_NOT_FOUND' }, 404);
      }
      // Some adapters strip `input` once a run completes (storage minimization).
      // We cannot replay without the original payload, so signal 501 rather
      // than synthesizing an empty input that could mask a real bug.
      if (sourceRun.input === undefined) {
        return c.json(
          {
            error: 'Adapter did not retain run input; replay is not supported for this run',
            code: 'CAPABILITY_NOT_SUPPORTED',
          },
          501,
        );
      }

      // Optional override body: { idempotencyKey?: string, metadata?: Record<...> }
      let body: Record<string, unknown> = {};
      const rawText = await c.req.text();
      if (rawText.length > 0) {
        try {
          const parsed = JSON.parse(rawText);
          if (isPlainObject(parsed)) {
            body = parsed;
          }
        } catch {
          return c.json({ error: 'Invalid JSON in request body' }, 400);
        }
      }

      // Derive a new idempotency key with a `:replay:<timestamp>` suffix so
      // the replay does not collide with the original run, while still being
      // deterministic if the caller retries with the same body.
      const headerIdempotencyKey = c.req.header('idempotency-key');
      const overrideIdempotencyKey =
        typeof body['idempotencyKey'] === 'string' && (body['idempotencyKey'] as string).length > 0
          ? (body['idempotencyKey'] as string)
          : typeof headerIdempotencyKey === 'string' && headerIdempotencyKey.length > 0
            ? headerIdempotencyKey
            : undefined;
      const replayIdempotencyKey = overrideIdempotencyKey ?? `${sourceId}:replay:${Date.now()}`;

      const replayOptions: RunOptions = {
        idempotencyKey: replayIdempotencyKey,
      };
      if (sourceRun.tenantId) {
        replayOptions.tenantId = sourceRun.tenantId;
      }
      if (sourceRun.priority !== undefined) {
        replayOptions.priority = sourceRun.priority;
      }
      if (sourceRun.tags && Object.keys(sourceRun.tags).length > 0) {
        replayOptions.tags = { ...sourceRun.tags };
      }
      // Stamp replay metadata so observability tooling can trace the chain
      // back to the original run without needing a separate join table.
      const mergedMetadata: Record<string, unknown> = {
        ...(sourceRun.metadata ?? {}),
        replayOf: sourceId,
        replayedAt: new Date().toISOString(),
      };
      if (isPlainObject(body['metadata'])) {
        Object.assign(mergedMetadata, body['metadata'] as Record<string, unknown>);
      }
      if (requestContext.actorId) {
        mergedMetadata['replayedBy'] = requestContext.actorId;
      }
      replayOptions.metadata = mergedMetadata;

      const handle =
        sourceRun.type === 'workflow'
          ? await options.runtime.runWorkflow(sourceRun.name, sourceRun.input, replayOptions)
          : await options.runtime.runTask(sourceRun.name, sourceRun.input, replayOptions);

      const newRun = await options.runtime.getRun(handle.id);
      return c.json(
        {
          id: handle.id,
          type: sourceRun.type,
          name: sourceRun.name,
          status: newRun?.status ?? 'pending',
          replayOf: sourceId,
          links: {
            run: buildRunLink(c, handle.id),
          },
        },
        202,
      );
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(buildErrorPayload(error), status);
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
        wrap,
      );
      return c.json(listed);
    } catch (error) {
      if (error instanceof TimeoutError) {
        return c.json(timeoutErrorBody(error), 504);
      }
      const status = mapErrorToStatus(error);
      return c.json(buildErrorPayload(error), status);
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
      let parseError = false;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        parseError = true;
        body = {};
      }
      if (parseError) {
        return c.json({ error: 'Invalid JSON in request body' }, 400);
      }
      await options.runtime.signal(c.req.param('id'), c.req.param('signalName'), body['payload']);
      return c.json({ status: 'accepted' }, 202);
    } catch (error) {
      const status = mapErrorToStatus(error);
      return c.json(buildErrorPayload(error), status);
    }
  });

  return router;
}
