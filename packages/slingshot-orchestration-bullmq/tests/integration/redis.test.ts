/**
 * Real-Redis integration test for slingshot-orchestration-bullmq.
 *
 * Gated by `REDIS_URL`. When the env var is unset the entire suite is skipped.
 * To exercise the live broker path:
 *
 *   REDIS_URL=redis://localhost:6379 bun test packages/slingshot-orchestration-bullmq/tests/integration
 *
 * Uses ioredis directly to verify that the BullMQ orchestration adapter can
 * connect to Redis, create queues/workers, and process tasks through the live
 * BullMQ infrastructure.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';

const REDIS_URL = process.env.REDIS_URL;
const skipIfRedis = (cond: boolean) => (cond ? test.skip : test);
const it = skipIfRedis(!REDIS_URL);

interface RedisConnection {
  host: string;
  port: number;
  password?: string;
}

function parseRedisUrl(url: string): RedisConnection {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

describe('createBullMQOrchestrationAdapter — real Redis', () => {
  let conn: RedisConnection;

  beforeAll(async () => {
    if (!REDIS_URL) return;
    conn = parseRedisUrl(REDIS_URL);
    // eslint-disable-next-line no-console
    console.info(`[redis-integration-orchestration] using REDIS_URL=${REDIS_URL}`);
  });

  let lastShutdown: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (lastShutdown) {
      await lastShutdown().catch(() => undefined);
      lastShutdown = null;
    }
  });

  it('starts the adapter and runs a task through live BullMQ', async () => {
    if (!REDIS_URL) return;
    const { createBullMQOrchestrationAdapter } = await import('../src/adapter');

    const task = defineTask({
      name: 'redis-echo-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        return { echoed: input.value };
      },
    });

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: conn.host, port: conn.port, password: conn.password },
      prefix: `test-orch-redis-${Date.now()}`,
    });
    adapter.registerTask(task);
    lastShutdown = async () => { await adapter.shutdown(); };

    const handle = await adapter.runTask(task.name, { value: 'real-redis' });
    const result = await handle.result();
    expect(result).toEqual({ echoed: 'real-redis' });
  });

  it('supports idempotency through live BullMQ', async () => {
    if (!REDIS_URL) return;
    const { createBullMQOrchestrationAdapter } = await import('../src/adapter');

    let executions = 0;
    const task = defineTask({
      name: 'redis-idempotent-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        executions += 1;
        return { ok: true };
      },
    });

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: conn.host, port: conn.port, password: conn.password },
      prefix: `test-orch-idem-${Date.now()}`,
    });
    adapter.registerTask(task);
    lastShutdown = async () => { await adapter.shutdown(); };

    const first = await adapter.runTask(task.name, {}, { idempotencyKey: 'integ-key-1' });
    await first.result();
    expect(executions).toBe(1);

    const replay = await adapter.runTask(task.name, {}, { idempotencyKey: 'integ-key-1' });
    expect(replay.id).toBe(first.id);
    expect(executions).toBe(1);
  });

  it('supports scheduling and unscheduling through live BullMQ', async () => {
    if (!REDIS_URL) return;
    const { createBullMQOrchestrationAdapter } = await import('../src/adapter');

    const task = defineTask({
      name: 'redis-schedule-task',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    });

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: conn.host, port: conn.port, password: conn.password },
      prefix: `test-orch-sched-${Date.now()}`,
    });
    adapter.registerTask(task);
    lastShutdown = async () => { await adapter.shutdown(); };

    const schedule = await adapter.schedule(
      { type: 'task', name: task.name },
      '* * * * *',
    );
    expect(schedule).toBeDefined();
    expect(schedule.id).toBeDefined();

    const schedules = await adapter.listSchedules();
    expect(schedules.length).toBeGreaterThanOrEqual(1);

    await adapter.unschedule(schedule.id);
    const afterUnsched = await adapter.listSchedules();
    expect(afterUnsched.find(s => s.id === schedule.id)).toBeUndefined();
  });

  it('shuts down gracefully', async () => {
    if (!REDIS_URL) return;
    const { createBullMQOrchestrationAdapter } = await import('../src/adapter');

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: conn.host, port: conn.port, password: conn.password },
      prefix: `test-orch-shutdown-${Date.now()}`,
    });
    lastShutdown = async () => { await adapter.shutdown(); };

    await expect(adapter.shutdown()).resolves.toBeUndefined();
    // Second shutdown is idempotent
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('handles task failure gracefully through live BullMQ', async () => {
    if (!REDIS_URL) return;
    const { createBullMQOrchestrationAdapter } = await import('../src/adapter');

    const failingTask = defineTask({
      name: 'redis-failing-task',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        throw new Error('intentional failure');
      },
    });

    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: conn.host, port: conn.port, password: conn.password },
      prefix: `test-orch-fail-${Date.now()}`,
    });
    adapter.registerTask(failingTask);
    lastShutdown = async () => { await adapter.shutdown(); };

    const handle = await adapter.runTask(failingTask.name, {});
    await expect(handle.result()).rejects.toThrow('intentional failure');
  });
});
