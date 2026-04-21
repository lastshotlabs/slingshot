import { getAuthenticatedAccountGuardFailure } from '@framework/lib/authRouteGuard';
import type { QueueFactory } from '@lib/queue';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { createRoute, withSecurity } from '@lastshotlabs/slingshot-core';
import {
  createRouter,
  getActorId,
  getRouteAuth,
  getSlingshotCtx,
} from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import type { JobsConfig } from '../../config/types/jobs';

/**
 * Minimal shape of job data expected by the jobs API routes.
 *
 * The `userId` field is used when `scopeToUser` is enabled — only jobs whose
 * `data.userId` matches the authenticated user's ID are returned or accessible.
 * Additional application-specific fields are permitted via the index signature.
 */
interface SlingshotJobData {
  /** ID of the user that owns this job (used for `scopeToUser` filtering). */
  userId?: string;
  [key: string]: unknown;
}

const tags = ['Jobs'];
const ErrorResponse = z.object({ error: z.string() });

const JobStatusResponse = z
  .object({
    id: z.string().describe('Job ID.'),
    state: z.string().describe('Job state: waiting, active, completed, failed, delayed, paused.'),
    progress: z.union([z.number(), z.record(z.string(), z.unknown())]).describe('Job progress.'),
    result: z.unknown().optional().describe('Job result (when completed).'),
    failedReason: z.string().optional().describe('Failure reason (when failed).'),
    attemptsMade: z.number().describe('Number of attempts made.'),
    timestamp: z.number().describe('Unix timestamp (ms) when the job was created.'),
    finishedOn: z.number().optional().describe('Unix timestamp (ms) when the job finished.'),
  })
  .openapi('JobStatus');

/**
 * Create a Hono router that exposes BullMQ job-status endpoints.
 *
 * Mounts the following routes under the app:
 * - `GET /jobs` — list allowed queue names.
 * - `GET /jobs/:queue` — paginated list of jobs in a queue, filterable by state.
 * - `GET /jobs/:queue/dead-letters` — paginated list of dead-letter queue jobs.
 * - `GET /jobs/:queue/:id` — status, progress, and result for a single job.
 * - `GET /jobs/:queue/:id/logs` — log entries for a single job.
 *
 * Security:
 * - In production, `config.auth` must be set (or `unsafePublic: true` must be
 *   explicitly provided); otherwise the router throws at construction time.
 * - When `scopeToUser` is `true` and user auth is in effect, list and get
 *   endpoints filter results to jobs owned by the authenticated user
 *   (matched via `job.data.userId`).
 * - When `auth` is `"userAuth"`, route handlers fail closed for stale sessions
 *   that belong to suspended accounts or accounts that no longer satisfy a
 *   required email-verification policy.
 *
 * @param config - Jobs route configuration.  See `JobsConfig` for all options.
 * @param queueFactory - Factory that creates BullMQ `Queue` instances by name.
 * @param isProd - Whether to enforce production-mode security checks.
 * @returns An OpenAPI-annotated Hono router.
 * @throws {Error} In production when `config.auth === "none"` and
 *   `config.unsafePublic` is not set.
 * @throws {Error} When `config.scopeToUser === true` but `config.auth !== "userAuth"`.
 */
export const createJobsRouter = (
  config: JobsConfig,
  queueFactory: QueueFactory,
  isProd: boolean,
) => {
  const router = createRouter();
  const allowedQueues = new Set<string>(config.allowedQueues ?? []);
  const authConfig = config.auth ?? 'none';
  const scopeToUser = config.scopeToUser ?? false;

  if (isProd && authConfig === 'none' && !config.unsafePublic) {
    throw new Error(
      '[security] jobs.auth is required in production. Set jobs.auth or set unsafePublic: true.',
    );
  }
  if (scopeToUser && authConfig !== 'userAuth') {
    throw new Error(
      '[security] jobs.scopeToUser requires jobs.auth = "userAuth". ' +
        'Custom middleware cannot safely prove per-user job ownership unless it publishes the canonical actor identity.',
    );
  }

  // Determine if userAuth is involved (for scopeToUser and OpenAPI security schemes)
  const hasUserAuth = authConfig === 'userAuth';

  // Apply middleware based on config
  if (authConfig === 'userAuth') {
    router.use('/jobs/*', (c: Context<AppEnv, string>, next: Next) =>
      getRouteAuth(getSlingshotCtx(c)).userAuth(c, next),
    );
    router.use('/jobs', async (c, next) => {
      const guardFailure = await getAuthenticatedAccountGuardFailure(c);
      if (guardFailure) return c.json({ error: guardFailure.error }, guardFailure.status);
      await next();
    });
    router.use('/jobs/*', async (c, next) => {
      const guardFailure = await getAuthenticatedAccountGuardFailure(c);
      if (guardFailure) return c.json({ error: guardFailure.error }, guardFailure.status);
      await next();
    });
    if (config.roles?.length) {
      const roles = config.roles;
      router.use('/jobs/*', (c: Context<AppEnv, string>, next: Next) =>
        getRouteAuth(getSlingshotCtx(c)).requireRole(...roles)(c, next),
      );
    }
  } else if (Array.isArray(authConfig)) {
    for (const mw of authConfig) {
      router.use('/jobs/*', mw);
    }
  }
  // "none" requires no middleware

  function isQueueAllowed(queueName: string): boolean {
    return allowedQueues.has(queueName);
  }

  /** Determine OpenAPI security for a route */
  function applyRouteSecurity<T extends ReturnType<typeof createRoute>>(route: T) {
    if (authConfig === 'userAuth') {
      return withSecurity(route, { cookieAuth: [] }, { userToken: [] });
    }
    if (Array.isArray(authConfig)) {
      // Custom middleware — mark as cookieAuth/userToken if it likely includes userAuth
      return withSecurity(route, { cookieAuth: [] }, { userToken: [] });
    }
    return route;
  }

  /** Map a BullMQ job to the response shape */
  async function jobToResponse(job: {
    id?: string | null;
    progress: unknown;
    returnvalue: unknown;
    failedReason?: string | null;
    attemptsMade: number;
    timestamp: number;
    finishedOn?: number | null;
    getState: () => Promise<string>;
  }) {
    const state = await job.getState();
    if (!job.id) throw new Error('[jobs] Job is missing an id');
    return {
      id: job.id,
      state,
      progress: job.progress as number | Record<string, unknown>,
      result: job.returnvalue,
      failedReason: job.failedReason ?? undefined,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn ?? undefined,
    };
  }

  // ─── List available queues ──────────────────────────────────────────────

  const listQueuesRoute = createRoute({
    method: 'get',
    path: '/jobs',
    summary: 'List available queues',
    description: 'Returns the list of queue names exposed via the API.',
    tags,
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              queues: z.array(z.string()).describe('Available queue names.'),
            }),
          },
        },
        description: 'Available queues.',
      },
      403: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Account is suspended or must verify its email before job access is allowed.',
      },
    },
  });

  router.openapi(applyRouteSecurity(listQueuesRoute), c => {
    return c.json({ queues: Array.from(allowedQueues) }, 200);
  });

  // ─── List jobs in a queue ─────────────────────────────────────────────

  const listJobsRoute = createRoute({
    method: 'get',
    path: '/jobs/{queue}',
    summary: 'List jobs in a queue',
    description: 'Returns a paginated list of jobs in a queue, optionally filtered by state.',
    tags,
    request: {
      params: z.object({
        queue: z.string().describe('Queue name.'),
      }),
      query: z.object({
        state: z
          .enum(['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'])
          .optional()
          .describe('Filter by job state.'),
        start: z.string().optional().describe('Start index. Default: 0.'),
        end: z.string().optional().describe('End index. Default: 19.'),
      }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              jobs: z.array(JobStatusResponse),
              total: z.number().describe('Total jobs matching the filter.'),
            }),
          },
        },
        description: 'Jobs list.',
      },
      403: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Queue not allowed.',
      },
    },
  });

  router.openapi(applyRouteSecurity(listJobsRoute), async c => {
    const { queue: queueName } = c.req.valid('param');
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: 'Queue not allowed' }, 403);
    }

    const { state, start: startStr, end: endStr } = c.req.valid('query');
    const start = startStr ? parseInt(startStr) : 0;
    const end = endStr ? parseInt(endStr) : 19;

    const queue = queueFactory.createQueue(queueName);

    // Get jobs by state or all jobs
    const stateFilter = state ?? 'waiting';
    const jobs = await queue.getJobs([stateFilter], start, end);

    // Get total count for the filtered state
    const counts = await queue.getJobCounts(stateFilter);
    const total = counts[stateFilter] ?? 0;

    // Optionally filter by userId
    let filteredJobs = jobs;
    if (scopeToUser && hasUserAuth) {
      const userId = getActorId(c);
      filteredJobs = jobs.filter(job => (job.data as SlingshotJobData).userId === userId);
    }

    const result = await Promise.all(filteredJobs.map(jobToResponse));
    // NOTE: When scopeToUser is active, total is a page-local filtered count, not a
    // globally accurate total. BullMQ does not support server-side user filtering.
    return c.json(
      { jobs: result, total: scopeToUser && hasUserAuth ? filteredJobs.length : total },
      200,
    );
  });

  // ─── Dead letter queue ────────────────────────────────────────────────
  // Must be registered BEFORE getJobRoute so that the literal path segment
  // "dead-letters" is matched before the parameterised {id} segment.

  const getDlqRoute = createRoute({
    method: 'get',
    path: '/jobs/{queue}/dead-letters',
    summary: 'List dead letter queue jobs',
    description:
      'Returns paginated list of jobs in the dead letter queue for a given source queue.',
    tags,
    request: {
      params: z.object({
        queue: z.string().describe('Source queue name (DLQ name is {queue}-dlq).'),
      }),
      query: z.object({
        start: z.string().optional().describe('Start index. Default: 0.'),
        end: z.string().optional().describe('End index. Default: 19.'),
      }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              jobs: z.array(JobStatusResponse),
              total: z.number().describe('Total jobs in DLQ.'),
            }),
          },
        },
        description: 'DLQ jobs.',
      },
      403: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Queue not allowed.',
      },
    },
  });

  router.openapi(applyRouteSecurity(getDlqRoute), async c => {
    const { queue: queueName } = c.req.valid('param');
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: 'Queue not allowed' }, 403);
    }

    const { start: startStr, end: endStr } = c.req.valid('query');
    const start = startStr ? parseInt(startStr) : 0;
    const end = endStr ? parseInt(endStr) : 19;

    const dlqQueue = queueFactory.createQueue(`${queueName}-dlq`);
    const [jobs, total] = await Promise.all([
      dlqQueue.getWaiting(start, end),
      dlqQueue.getWaitingCount(),
    ]);

    let filteredJobs = jobs;
    if (scopeToUser && hasUserAuth) {
      const userId = getActorId(c);
      filteredJobs = jobs.filter(job => (job.data as SlingshotJobData).userId === userId);
    }

    const result = await Promise.all(filteredJobs.map(jobToResponse));
    // NOTE: When scopeToUser is active, total is a page-local filtered count, not a
    // globally accurate total. BullMQ does not support server-side user filtering.
    return c.json(
      { jobs: result, total: scopeToUser && hasUserAuth ? filteredJobs.length : total },
      200,
    );
  });

  // ─── Get job status ─────────────────────────────────────────────────────

  const getJobRoute = createRoute({
    method: 'get',
    path: '/jobs/{queue}/{id}',
    summary: 'Get job status',
    description: 'Returns the current state, progress, result, or failure reason for a job.',
    tags,
    request: {
      params: z.object({
        queue: z.string().describe('Queue name.'),
        id: z.string().describe('Job ID.'),
      }),
    },
    responses: {
      200: {
        content: { 'application/json': { schema: JobStatusResponse } },
        description: 'Job status.',
      },
      403: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Queue not in allowedQueues.',
      },
      404: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Job not found.',
      },
    },
  });

  router.openapi(applyRouteSecurity(getJobRoute), async c => {
    const { queue: queueName, id } = c.req.valid('param');
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: 'Queue not allowed' }, 403);
    }

    const queue = queueFactory.createQueue(queueName);
    const job = await queue.getJob(id);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    // Scope to user if configured
    if (scopeToUser && hasUserAuth) {
      const userId = getActorId(c);
      if ((job.data as SlingshotJobData).userId !== userId) {
        return c.json({ error: 'Job not found' }, 404);
      }
    }

    return c.json(await jobToResponse(job), 200);
  });

  // ─── Get job logs ───────────────────────────────────────────────────────

  const getJobLogsRoute = createRoute({
    method: 'get',
    path: '/jobs/{queue}/{id}/logs',
    summary: 'Get job logs',
    description: 'Returns logs for a specific job.',
    tags,
    request: {
      params: z.object({
        queue: z.string().describe('Queue name.'),
        id: z.string().describe('Job ID.'),
      }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              logs: z.array(z.string()).describe('Log entries.'),
              count: z.number().describe('Total log count.'),
            }),
          },
        },
        description: 'Job logs.',
      },
      403: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Queue not allowed.',
      },
      404: {
        content: { 'application/json': { schema: ErrorResponse } },
        description: 'Job not found.',
      },
    },
  });

  router.openapi(applyRouteSecurity(getJobLogsRoute), async c => {
    const { queue: queueName, id } = c.req.valid('param');
    if (!isQueueAllowed(queueName)) {
      return c.json({ error: 'Queue not allowed' }, 403);
    }

    const queue = queueFactory.createQueue(queueName);
    const job = await queue.getJob(id);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    if (scopeToUser && hasUserAuth) {
      const userId = getActorId(c);
      if ((job.data as SlingshotJobData).userId !== userId) {
        return c.json({ error: 'Job not found' }, 404);
      }
    }

    const { logs, count } = await queue.getJobLogs(id);
    return c.json({ logs, count }, 200);
  });

  return router;
};
