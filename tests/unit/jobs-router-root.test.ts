import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { describe, expect, mock, test } from 'bun:test';
import { type SlingshotContext, createRouter } from '@lastshotlabs/slingshot-core';
import { createJobsRouter } from '../../src/framework/routes/jobs';

interface FakeJob {
  id: string | null;
  data: Record<string, unknown>;
  progress: number | Record<string, unknown>;
  returnvalue: unknown;
  failedReason?: string | null;
  attemptsMade: number;
  timestamp: number;
  finishedOn?: number | null;
  state: string;
  getState(): Promise<string>;
}

function makeFakeJob(overrides: Partial<FakeJob> = {}): FakeJob {
  const job: FakeJob = {
    id: 'job-1',
    data: { userId: 'user-abc' },
    progress: 0,
    returnvalue: null,
    failedReason: undefined,
    attemptsMade: 1,
    timestamp: 1_000_000,
    finishedOn: undefined,
    state: 'waiting',
    async getState() {
      return job.state;
    },
    ...overrides,
  };
  return job;
}

function makeAuthRuntime(opts?: {
  suspended?: boolean;
  emailVerificationRequired?: boolean;
  emailVerified?: boolean;
}): AuthRuntimeContext {
  return {
    adapter: {
      getSuspended: async () => ({ suspended: opts?.suspended ?? false }),
      getEmailVerified: async () => opts?.emailVerified ?? true,
    },
    config: {
      emailVerification: opts?.emailVerificationRequired ? { required: true } : undefined,
      primaryField: 'email',
    },
  } as unknown as AuthRuntimeContext;
}

function makeApp(
  config: Parameters<typeof createJobsRouter>[0],
  queueFactory: {
    createQueue(name: string): {
      getJobs(states: string[], start?: number, end?: number): Promise<FakeJob[]>;
      getJobCounts(state: string): Promise<Record<string, number>>;
      getJob(id: string): Promise<FakeJob | null>;
      getJobLogs(id: string): Promise<{ logs: string[]; count: number }>;
      getWaiting(start?: number, end?: number): Promise<FakeJob[]>;
      getWaitingCount(): Promise<number>;
    };
  },
  options?: {
    authRuntime?: AuthRuntimeContext;
    requireRoleSpy?: ReturnType<typeof mock>;
  },
) {
  const requireRoleSpy =
    options?.requireRoleSpy ??
    mock((_roles: string[]) => {
      return async (_c: unknown, next: () => Promise<void>) => {
        await next();
      };
    });

  const slingshotCtx = {
    routeAuth: {
      userAuth: async (c: any, next: () => Promise<void>) => {
        const token = c.req.header('authorization') ?? c.req.header('x-user-token');
        if (!token) return c.json({ error: 'Unauthorized' }, 401);
        c.set('authUserId', 'user-abc');
        await next();
      },
      requireRole:
        (...roles: string[]) =>
        async (c: any, next: () => Promise<void>) => {
          requireRoleSpy(roles);
          await next();
        },
    },
    pluginState: new Map([[AUTH_RUNTIME_KEY, options?.authRuntime ?? makeAuthRuntime()]]),
  } as unknown as SlingshotContext;

  const app = createRouter();
  app.use('*', async (c, next) => {
    c.set('slingshotCtx', slingshotCtx);
    await next();
  });
  app.route('/', createJobsRouter(config, queueFactory as any, false));
  return { app, requireRoleSpy };
}

function makeQueueFactory(overrides?: {
  jobs?: FakeJob[];
  waitingJobs?: FakeJob[];
  logs?: { logs: string[]; count: number };
  counts?: Record<string, number>;
}) {
  const jobs = overrides?.jobs ?? [];
  const waitingJobs = overrides?.waitingJobs ?? [];
  const logs = overrides?.logs ?? { logs: ['step 1'], count: 1 };
  const counts = overrides?.counts ?? { waiting: jobs.length };

  return {
    createQueue(_name: string) {
      return {
        async getJobs(_states: string[], _start = 0, _end = 19) {
          return jobs;
        },
        async getJobCounts(_state: string) {
          return counts;
        },
        async getJob(id: string) {
          return jobs.find(job => job.id === id) ?? null;
        },
        async getJobLogs(_id: string) {
          return logs;
        },
        async getWaiting(_start = 0, _end = 19) {
          return waitingJobs;
        },
        async getWaitingCount() {
          return waitingJobs.length;
        },
      };
    },
  };
}

describe('createJobsRouter (root coverage)', () => {
  test('fails closed in production when auth is none without unsafePublic', () => {
    expect(() =>
      createJobsRouter(
        {
          allowedQueues: ['my-queue'],
          auth: 'none',
          statusEndpoint: true,
        },
        makeQueueFactory() as any,
        true,
      ),
    ).toThrow(/jobs\.auth is required in production/i);
  });

  test('scopeToUser requires userAuth', () => {
    expect(() =>
      createJobsRouter(
        {
          allowedQueues: ['my-queue'],
          auth: 'none',
          scopeToUser: true,
          statusEndpoint: true,
        },
        makeQueueFactory() as any,
        false,
      ),
    ).toThrow(/scopeToUser requires jobs\.auth = "userAuth"/i);
  });

  test('lists configured queues', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['q1', 'q2'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory(),
    );

    const response = await app.request('/jobs');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ queues: ['q1', 'q2'] });
  });

  test('blocks stale suspended accounts for the /jobs listing route', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        statusEndpoint: true,
      },
      makeQueueFactory(),
      {
        authRuntime: makeAuthRuntime({ suspended: true }),
      },
    );

    const response = await app.request('/jobs', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Account suspended' });
  });

  test('rejects unauthenticated userAuth requests for both listing routes', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'job-1' })],
      }),
    );

    const listQueuesResponse = await app.request('/jobs');
    const listJobsResponse = await app.request('/jobs/my-queue');

    expect(listQueuesResponse.status).toBe(401);
    expect(listJobsResponse.status).toBe(401);
  });

  test('applies requireRole middleware when roles are configured', async () => {
    const requireRoleSpy = mock(() => {});
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        roles: ['admin'],
        statusEndpoint: true,
      },
      makeQueueFactory(),
      { requireRoleSpy },
    );

    const response = await app.request('/jobs/my-queue', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(200);
    expect(requireRoleSpy).toHaveBeenCalledWith(['admin']);
  });

  test('filters listed jobs to the authenticated user when scopeToUser is enabled', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        scopeToUser: true,
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [
          makeFakeJob({ id: 'mine', data: { userId: 'user-abc' } }),
          makeFakeJob({ id: 'other', data: { userId: 'user-xyz' } }),
        ],
        counts: { waiting: 2 },
      }),
    );

    const response = await app.request('/jobs/my-queue', {
      headers: { authorization: 'Bearer test' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe('mine');
    expect(body.total).toBe(1);
  });

  test('passes state and pagination filters through to the queue adapter', async () => {
    const getJobs = mock(async (_states: string[], _start = 0, _end = 19) => [
      makeFakeJob({ id: 'failed-job', state: 'failed' }),
    ]);
    const getJobCounts = mock(async (_state: string) => ({ failed: 1 }));
    const queueFactory = {
      createQueue(_name: string) {
        return {
          getJobs,
          getJobCounts,
          async getJob(id: string) {
            return makeFakeJob({ id });
          },
          async getJobLogs(_id: string) {
            return { logs: [], count: 0 };
          },
          async getWaiting(_start = 0, _end = 19) {
            return [];
          },
          async getWaitingCount() {
            return 0;
          },
        };
      },
    };
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      queueFactory,
    );

    const response = await app.request('/jobs/my-queue?state=failed&start=2&end=4');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getJobs).toHaveBeenCalledWith(['failed'], 2, 4);
    expect(getJobCounts).toHaveBeenCalledWith('failed');
    expect(body.jobs[0].state).toBe('failed');
    expect(body.total).toBe(1);
  });

  test('rejects disallowed queues when listing jobs', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory(),
    );

    const response = await app.request('/jobs/not-allowed');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Queue not allowed' });
  });

  test('blocks stale unverified accounts on queue listings when verification is required', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'job-1', data: { userId: 'user-abc' } })],
      }),
      {
        authRuntime: makeAuthRuntime({
          emailVerificationRequired: true,
          emailVerified: false,
        }),
      },
    );

    const response = await app.request('/jobs/my-queue', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Email not verified' });
  });

  test('returns 404 when a scoped job belongs to a different user', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        scopeToUser: true,
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'other-job', data: { userId: 'someone-else' } })],
      }),
    );

    const response = await app.request('/jobs/my-queue/other-job', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Job not found' });
  });

  test('returns a scoped job when it belongs to the authenticated user', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        scopeToUser: true,
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'my-job', data: { userId: 'user-abc' } })],
      }),
    );

    const response = await app.request('/jobs/my-queue/my-job', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'my-job', state: 'waiting' });
  });

  test('returns 404 when a job is missing', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory(),
    );

    const response = await app.request('/jobs/my-queue/missing-job');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Job not found' });
  });

  test('rejects disallowed queues when reading a job', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'job-1' })],
      }),
    );

    const response = await app.request('/jobs/not-allowed/job-1');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Queue not allowed' });
  });

  test('returns dead-letter jobs for an allowed queue', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory({
        waitingJobs: [makeFakeJob({ id: 'dlq-1', state: 'waiting' })],
      }),
    );

    const response = await app.request('/jobs/my-queue/dead-letters');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.jobs[0].id).toBe('dlq-1');
  });

  test('filters dead-letter jobs to the authenticated user when scopeToUser is enabled', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        scopeToUser: true,
        statusEndpoint: true,
      },
      makeQueueFactory({
        waitingJobs: [
          makeFakeJob({ id: 'mine-dlq', data: { userId: 'user-abc' } }),
          makeFakeJob({ id: 'other-dlq', data: { userId: 'user-xyz' } }),
        ],
      }),
    );

    const response = await app.request('/jobs/my-queue/dead-letters', {
      headers: { authorization: 'Bearer test' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe('mine-dlq');
    expect(body.total).toBe(1);
  });

  test('rejects disallowed queues when reading dead letters', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory(),
    );

    const response = await app.request('/jobs/not-allowed/dead-letters');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Queue not allowed' });
  });

  test('returns logs for an existing job', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'job-logs' })],
        logs: { logs: ['line 1', 'line 2'], count: 2 },
      }),
    );

    const response = await app.request('/jobs/my-queue/job-logs/logs');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ logs: ['line 1', 'line 2'], count: 2 });
  });

  test('returns 404 when job logs are requested for a missing job', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory(),
    );

    const response = await app.request('/jobs/my-queue/missing-job/logs');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Job not found' });
  });

  test('returns 404 for scoped log requests that target another user', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        scopeToUser: true,
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'other-job', data: { userId: 'someone-else' } })],
      }),
    );

    const response = await app.request('/jobs/my-queue/other-job/logs', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Job not found' });
  });

  test('returns logs for scoped jobs owned by the authenticated user', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'userAuth',
        scopeToUser: true,
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'my-job', data: { userId: 'user-abc' } })],
        logs: { logs: ['owned log'], count: 1 },
      }),
    );

    const response = await app.request('/jobs/my-queue/my-job/logs', {
      headers: { authorization: 'Bearer test' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ logs: ['owned log'], count: 1 });
  });

  test('rejects disallowed queues when reading logs', async () => {
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: 'none',
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'job-1' })],
      }),
    );

    const response = await app.request('/jobs/not-allowed/job-1/logs');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Queue not allowed' });
  });

  test('runs custom auth middleware arrays for protected job routes', async () => {
    const authMiddleware = mock(async (_c: unknown, next: () => Promise<void>) => {
      await next();
    });
    const { app } = makeApp(
      {
        allowedQueues: ['my-queue'],
        auth: [authMiddleware as any],
        statusEndpoint: true,
      },
      makeQueueFactory({
        jobs: [makeFakeJob({ id: 'job-custom-auth' })],
      }),
    );

    const response = await app.request('/jobs/my-queue/job-custom-auth');

    expect(response.status).toBe(200);
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });
});
