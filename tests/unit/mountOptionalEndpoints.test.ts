import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createMetricsState } from '../../src/framework/metrics/registry';
import { mountOptionalEndpoints } from '../../src/framework/mountOptionalEndpoints';
import * as queueModule from '../../src/lib/queue';

describe('mountOptionalEndpoints', () => {
  afterEach(() => {
    const mocked = queueModule.createQueueFactory as unknown as { mockRestore?: () => void };
    mocked.mockRestore?.();
    const warnSpy = console.warn as unknown as { mockRestore?: () => void };
    warnSpy.mockRestore?.();
  });

  test('enforces jobs auth in production before creating queue infrastructure', () => {
    expect(() =>
      mountOptionalEndpoints(
        new OpenAPIHono<AppEnv>(),
        { statusEndpoint: true, auth: 'none' },
        undefined,
        undefined,
        createMetricsState(),
        {},
        true,
      ),
    ).toThrow('[security] jobs.auth is required in production');
  });

  test('enforces metrics auth in production before creating queue infrastructure', () => {
    expect(() =>
      mountOptionalEndpoints(
        new OpenAPIHono<AppEnv>(),
        undefined,
        { enabled: true, auth: 'none' },
        undefined,
        createMetricsState(),
        {},
        true,
      ),
    ).toThrow('[security] metrics.auth is required in production');
  });

  test('creates the shared queue factory lazily on the first jobs request', async () => {
    const createQueue = mock(() => ({
      getJobs: async () => [],
      getJobCounts: async () => ({ waiting: 0 }),
      getJob: async () => null,
      getJobLogs: async () => ({ logs: [], count: 0 }),
      getWaiting: async () => [],
      getWaitingCount: async () => 0,
    }));
    const cleanupStaleSchedulers = mock(async () => {});
    const createQueueFactory = spyOn(queueModule, 'createQueueFactory').mockReturnValue({
      createQueue,
      createWorker: mock(() => {
        throw new Error('not used');
      }),
      createCronWorker: mock(() => {
        throw new Error('not used');
      }),
      cleanupStaleSchedulers,
      createDLQHandler: mock(() => {
        throw new Error('not used');
      }),
    } as never);

    const app = new OpenAPIHono<AppEnv>();
    mountOptionalEndpoints(
      app,
      {
        statusEndpoint: true,
        auth: 'none',
        unsafePublic: true,
        allowedQueues: ['my-queue'],
      },
      {
        enabled: true,
        auth: 'none',
        unsafePublic: true,
        queues: ['my-queue'],
      },
      undefined,
      createMetricsState(),
      { redisHost: '127.0.0.1:6379' },
      false,
    );

    expect(createQueueFactory).not.toHaveBeenCalled();

    const response = await app.request('/jobs/my-queue');

    expect(response.status).toBe(200);
    expect(createQueueFactory).toHaveBeenCalledTimes(1);
    expect(createQueue).toHaveBeenCalledWith('my-queue');
    expect(cleanupStaleSchedulers).not.toHaveBeenCalled();
  });

  test('warns in non-production when jobs are exposed without auth', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    mountOptionalEndpoints(
      new OpenAPIHono<AppEnv>(),
      {
        statusEndpoint: true,
        auth: 'none',
        allowedQueues: ['my-queue'],
      },
      undefined,
      undefined,
      createMetricsState(),
      {},
      false,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[security] /jobs is enabled without auth. Configure jobs.auth for production.',
    );
  });

  test('surfaces missing REDIS_HOST only when the lazy queue factory is first used', async () => {
    const app = new OpenAPIHono<AppEnv>();

    mountOptionalEndpoints(
      app,
      {
        statusEndpoint: true,
        auth: 'none',
        unsafePublic: true,
        allowedQueues: ['my-queue'],
      },
      undefined,
      undefined,
      createMetricsState(),
      {},
      false,
    );

    const response = await app.request('/jobs/my-queue');

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Internal Server Error');
  });
});
