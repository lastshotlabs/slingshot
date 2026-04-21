/**
 * Tests src/routes/jobs.ts createJobsRouter with a mocked @lib/queue.
 *
 * Must run in an isolated bun test invocation to prevent mock leakage.
 * Mocks createQueueFactory BEFORE importing jobs.ts so the route handlers
 * get the fake Queue factory, not a real BullMQ + Redis connection.
 */
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import type { JobsConfig } from '../../src/app';
import { createJobsRouter } from '../../src/framework/routes/jobs';

interface FakeJob {
  id: string;
  name: string;
  data: unknown;
  progress: number;
  returnvalue: unknown;
  failedReason?: string;
  attemptsMade: number;
  timestamp: number;
  finishedOn?: number;
  _state: string;
  getState(): Promise<string>;
}

function makeFakeJob(overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id: 'job-1',
    name: 'test-job',
    data: { userId: 'user-abc' },
    progress: 0,
    returnvalue: null,
    failedReason: undefined,
    attemptsMade: 1,
    timestamp: 1_000_000,
    finishedOn: undefined,
    _state: 'waiting',
    getState() {
      return Promise.resolve(this._state);
    },
    ...overrides,
  };
}

let _jobs: FakeJob[] = [];
let _logs: { logs: string[]; count: number } = { logs: [], count: 0 };
let _waitingJobs: FakeJob[] = [];
let _waitingCount = 0;
let _counts: Record<string, number> = { waiting: 0 };

class FakeQueue {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  async getJobs(): Promise<FakeJob[]> {
    return _jobs;
  }

  async getJobCounts(): Promise<Record<string, number>> {
    return _counts;
  }

  async getJob(id: string): Promise<FakeJob | null> {
    return _jobs.find(j => j.id === id) ?? null;
  }

  async getJobLogs(): Promise<{ logs: string[]; count: number }> {
    return _logs;
  }

  async getWaiting(): Promise<FakeJob[]> {
    return _waitingJobs;
  }

  async getWaitingCount(): Promise<number> {
    return _waitingCount;
  }
}

mock.module('../../src/lib/queue', () => ({
  createQueueFactory: () => ({
    createQueue: (name: string) => new FakeQueue(name),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
mock.module('ioredis', () => ({ default: class {} }));
mock.module('bullmq', () => ({}));

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

function makeRouter(
  overrides: Partial<JobsConfig> = {},
  authRuntime: AuthRuntimeContext = makeAuthRuntime(),
) {
  const routeAuth = {
    userAuth: async (c: any, next: any) => {
      const token = c.req.header('authorization') || c.req.header('x-user-token');
      if (!token) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      c.set('authUserId', 'user-abc');
      await next();
    },
    requireRole: () => async (_c: any, next: any) => {
      await next();
    },
  };

  const app = createRouter();
  const slingshotCtx = {
    routeAuth,
    pluginState: new Map([[AUTH_RUNTIME_KEY, authRuntime]]),
  } as unknown as SlingshotContext;
  attachContext(app, slingshotCtx);
  const router = createJobsRouter(
    {
      allowedQueues: ['my-queue'],
      auth: 'none',
      statusEndpoint: true,
      ...overrides,
    },
    {
      createQueue: (name: string) => new FakeQueue(name),
    } as any,
    false,
  );
  app.route('/', router);
  return app;
}

function resetStore(jobs: FakeJob[] = []) {
  _jobs = jobs;
  _counts = { waiting: jobs.length };
  _waitingJobs = jobs;
  _waitingCount = jobs.length;
  _logs = { logs: ['log line 1'], count: 1 };
}

beforeEach(() => {
  resetStore([]);
});

afterEach(() => {
  resetStore([]);
});

describe('GET /jobs - list queues', () => {
  test('returns the list of allowed queues', async () => {
    const router = makeRouter({ allowedQueues: ['q1', 'q2'] });
    const res = await router.request('/jobs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queues).toContain('q1');
    expect(body.queues).toContain('q2');
  });

  test('returns an empty list when no queues are configured', async () => {
    const router = makeRouter({ allowedQueues: [] });
    const res = await router.request('/jobs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queues).toEqual([]);
  });

  test('blocks stale suspended user-auth sessions', async () => {
    const router = makeRouter({ auth: 'userAuth' }, makeAuthRuntime({ suspended: true }));
    const res = await router.request('/jobs', {
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Account suspended' });
  });
});

describe('GET /jobs/:queue - list jobs', () => {
  test('returns jobs for an allowed queue', async () => {
    resetStore([makeFakeJob({ id: 'j1', _state: 'waiting' })]);
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(1);
    expect(body.jobs[0].id).toBe('j1');
    expect(body.jobs[0].state).toBe('waiting');
    expect(typeof body.total).toBe('number');
  });

  test('returns 403 for a queue not in allowedQueues', async () => {
    const router = makeRouter({ allowedQueues: ['my-queue'] });
    const res = await router.request('/jobs/forbidden-queue');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Queue not allowed');
  });

  test('passes state filter and returns matching jobs', async () => {
    resetStore([makeFakeJob({ id: 'j2', _state: 'failed' })]);
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue?state=failed');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs[0].state).toBe('failed');
  });

  test('respects start/end pagination params', async () => {
    resetStore([makeFakeJob({ id: 'j3' })]);
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue?start=0&end=4');
    expect(res.status).toBe(200);
  });

  test('scopeToUser rejects unauthenticated jobs configs', () => {
    expect(() => makeRouter({ scopeToUser: true, auth: 'none' })).toThrow(
      /scopeToUser requires jobs\.auth = "userAuth"/i,
    );
  });

  test('scopeToUser filters jobs by authUserId when userAuth is enabled', async () => {
    const myJob = makeFakeJob({ id: 'j4', data: { userId: 'user-abc' } });
    const otherJob = makeFakeJob({ id: 'j5', data: { userId: 'user-xyz' } });
    _jobs = [myJob, otherJob];
    _counts = { waiting: 2 };

    const router = makeRouter({ scopeToUser: true, auth: 'userAuth' });
    const res = await router.request('/jobs/my-queue', {
      headers: { authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(1);
    expect(body.jobs[0].id).toBe('j4');
  });

  test('blocks stale unverified user-auth sessions', async () => {
    resetStore([makeFakeJob({ id: 'j6', data: { userId: 'user-abc' } })]);
    const router = makeRouter(
      { auth: 'userAuth' },
      makeAuthRuntime({ emailVerificationRequired: true, emailVerified: false }),
    );
    const res = await router.request('/jobs/my-queue', {
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Email not verified' });
  });

  test('scopeToUser rejects custom auth middleware chains', () => {
    expect(() =>
      makeRouter({
        scopeToUser: true,
        auth: [
          async (_c: any, next: any) => {
            await next();
          },
        ],
      }),
    ).toThrow(/scopeToUser requires jobs\.auth = "userAuth"/i);
  });
});

describe('GET /jobs/:queue/:id - get job status', () => {
  test('returns job status for an existing job', async () => {
    resetStore([makeFakeJob({ id: 'job-42', _state: 'completed' })]);
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue/job-42');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('job-42');
    expect(body.state).toBe('completed');
  });

  test('returns 404 for a job that does not exist', async () => {
    resetStore([]);
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue/nonexistent');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Job not found');
  });

  test('returns 403 for a queue not in allowedQueues', async () => {
    const router = makeRouter({ allowedQueues: ['my-queue'] });
    const res = await router.request('/jobs/other-queue/job-1');
    expect(res.status).toBe(403);
  });
});

describe('GET /jobs/:queue/:id/logs - get job logs', () => {
  test('returns logs for an existing job', async () => {
    resetStore([makeFakeJob({ id: 'log-job' })]);
    _logs = { logs: ['step 1', 'step 2'], count: 2 };
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue/log-job/logs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toEqual(['step 1', 'step 2']);
    expect(body.count).toBe(2);
  });

  test('returns 404 when job does not exist', async () => {
    resetStore([]);
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue/missing-job/logs');
    expect(res.status).toBe(404);
  });

  test('returns 403 for a disallowed queue', async () => {
    const router = makeRouter({ allowedQueues: ['my-queue'] });
    const res = await router.request('/jobs/bad-queue/job-1/logs');
    expect(res.status).toBe(403);
  });
});

describe('GET /jobs/:queue/dead-letters - DLQ', () => {
  test('returns DLQ jobs', async () => {
    const dlqJob = makeFakeJob({ id: 'dlq-1', _state: 'waiting' });
    _waitingJobs = [dlqJob];
    _waitingCount = 1;
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue/dead-letters');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.jobs.length).toBe(1);
  });

  test('returns 403 for a disallowed queue', async () => {
    const router = makeRouter({ allowedQueues: ['my-queue'] });
    const res = await router.request('/jobs/bad-queue/dead-letters');
    expect(res.status).toBe(403);
  });

  test('respects start/end params', async () => {
    _waitingJobs = [makeFakeJob({ id: 'dlq-2' })];
    _waitingCount = 1;
    const router = makeRouter();
    const res = await router.request('/jobs/my-queue/dead-letters?start=0&end=4');
    expect(res.status).toBe(200);
  });
});

describe("auth: 'userAuth' - blocks unauthenticated requests", () => {
  test('returns 401 when no auth token is provided', async () => {
    resetStore([makeFakeJob()]);
    const router = makeRouter({ auth: 'userAuth' });
    const res = await router.request('/jobs/my-queue');
    expect(res.status).toBe(401);
  });

  test('GET /jobs also requires auth (Hono /jobs/* wildcard matches /jobs)', async () => {
    const router = makeRouter({ auth: 'userAuth' });
    const res = await router.request('/jobs');
    expect(res.status).toBe(401);
  });
});
