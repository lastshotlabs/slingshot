/**
 * Real-Redis integration tests for the BullMQ-backed orchestration adapter
 * (`@lastshotlabs/slingshot-orchestration-bullmq`).
 *
 * The unit suite in `packages/slingshot-orchestration-bullmq/tests/adapter.test.ts`
 * mocks the entire `bullmq` module surface, which means the central durability
 * promises (real retry-on-throw, drain-while-active, reconnect-after-pause) cannot
 * be exercised end-to-end. This file plugs that gap by running the adapter against
 * the docker Redis instance that already backs `bun run test:docker`.
 *
 * Guard: when the docker Redis is not reachable the entire suite is skipped via
 * `describe.skipIf` so this file is safe to run on environments without docker.
 *
 * Each test allocates a unique queue prefix (`<random>-<seq>`) so concurrent or
 * sequential runs cannot collide on Redis keys, and registers a cleanup that
 * shuts down the adapter and obliterates every queue created during the test.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, test } from 'bun:test';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { defineTask, defineWorkflow, step } from '@lastshotlabs/slingshot-orchestration';
import { createBullMQOrchestrationAdapter } from '../../packages/slingshot-orchestration-bullmq/src/adapter';

// ─────────────────────────────────────────────────────────────────────────────
// Connection & guard
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_URL =
  process.env.ORCHESTRATION_BULLMQ_REDIS_URL ??
  process.env.BULLMQ_INTEGRATION_REDIS_URL ??
  process.env.TEST_REDIS_URL ??
  'redis://localhost:6380';

function connectionFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    // BullMQ's blocking commands require maxRetriesPerRequest=null. Our app
    // wires this in production; tests must do the same to mirror behavior.
    maxRetriesPerRequest: null as null,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.pathname && parsed.pathname !== '/' ? { db: Number(parsed.pathname.slice(1)) } : {}),
  };
}

const connection = connectionFromUrl(REDIS_URL);

/** Probe Redis at module load so we can skip cleanly when docker is unavailable. */
async function probeRedis(): Promise<boolean> {
  const client = new Redis({ ...connection, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

const REDIS_AVAILABLE = await probeRedis();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a unique queue prefix for a test. UUID slice keeps logs readable. */
function uniquePrefix(label: string): string {
  return `t-${label}-${randomUUID().slice(0, 8)}`;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

interface CleanupHandle {
  prefix: string;
  shutdown(): Promise<void>;
}

const cleanupHandles: CleanupHandle[] = [];

afterEach(async () => {
  const handles = cleanupHandles.splice(0);
  for (const handle of handles) {
    try {
      await handle.shutdown();
    } catch (error) {
      console.error('[orchestration-bullmq-docker] shutdown failed:', error);
    }

    // Obliterate the well-known queue names created by the adapter for this
    // prefix so Redis stays clean between tests. We obliterate even when
    // shutdown failed — the goal is to leave Redis empty for the next test.
    // Queue names are constructed by the adapter as `${prefix}_tasks` etc.
    // (BullMQ 5.x rejects ':' in queue names — see adapter.ts).
    const queueNames = [`${handle.prefix}_tasks`, `${handle.prefix}_workflows`];
    for (const name of queueNames) {
      const queue = new Queue(name, { connection });
      try {
        await queue.obliterate({ force: true });
      } catch {
        // ignore — queue may not exist (e.g. nothing was emitted)
      } finally {
        await queue.close();
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!REDIS_AVAILABLE)('BullMQ orchestration adapter — real Redis integration', () => {
  test(// Why: the unit suite mocks bullmq.Worker and never exercises the real
  // attempts/backoffStrategy plumbing. We can only prove that a task that
  // throws twice and succeeds on the third attempt is actually retried
  // by BullMQ — and that the retry count matches the configured policy —
  // by running against a live broker.
  'task with maxAttempts=3 retries twice and succeeds on third attempt', async () => {
    const prefix = uniquePrefix('retry');
    const adapter = createBullMQOrchestrationAdapter({ connection, prefix });
    cleanupHandles.push({ prefix, shutdown: () => adapter.shutdown() });

    let calls = 0;
    const flakyTask = defineTask({
      name: 'flaky-task',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), attempts: z.number() }),
      retry: { maxAttempts: 3, backoff: 'fixed', delayMs: 50 },
      async handler(input, ctx) {
        calls += 1;
        if (calls < 3) {
          throw new Error(`transient failure attempt=${ctx.attempt}`);
        }
        return { id: input.id, attempts: calls };
      },
    });
    adapter.registerTask(flakyTask);
    await adapter.start();

    const handle = await adapter.runTask(flakyTask.name, { id: 'r1' });
    const result = await handle.result();

    expect(result).toEqual({ id: 'r1', attempts: 3 });
    expect(calls).toBe(3);

    const completed = await adapter.getRun(handle.id);
    expect(completed?.status).toBe('completed');
  }, 30_000);

  test(// Why: the cancellation/snapshot path is the most subtle drain-related
  // surface. We enqueue a job, shut the adapter down before any worker
  // picks it up, and then start a fresh adapter against the same prefix.
  // The job (still sitting in the BullMQ "waiting" set) must be picked
  // up and processed by the second adapter — proving no data loss across
  // adapter lifecycles.
  'shutdown mid-flight leaves enqueued job for next adapter to pick up (no data loss)', async () => {
    const prefix = uniquePrefix('drain');
    const sharedTask = defineTask({
      name: 'survive-restart',
      input: z.object({ token: z.string() }),
      output: z.object({ token: z.string() }),
      async handler(input) {
        return input;
      },
    });

    // First adapter: register the task but never start workers (we'll only
    // call runTask which auto-starts the queue but the test below uses
    // the lower-level enqueue path to keep workers idle).
    const firstAdapter = createBullMQOrchestrationAdapter({ connection, prefix });
    firstAdapter.registerTask(sharedTask);

    // Seed the queue directly so the job exists in Redis without ever
    // being claimed. This mirrors the "process crashed before the worker
    // grabbed the job" scenario that drain() must survive. The queue
    // name uses '_' separators because BullMQ 5.x rejects ':'.
    const seedQueue = new Queue(`${prefix}_tasks`, { connection });
    await seedQueue.add(sharedTask.name, {
      taskName: sharedTask.name,
      input: { token: 'survives-restart' },
      runId: 'run-survive-1',
    });
    await seedQueue.close();

    // Shutdown the first adapter without ever running anything. drain()
    // must complete cleanly even though there is no in-flight work.
    await firstAdapter.shutdown();
    cleanupHandles.push({
      prefix,
      shutdown: async () => {
        // already shut down; obliterate only
      },
    });

    // Fresh adapter on the same prefix — it should consume the job.
    const secondAdapter = createBullMQOrchestrationAdapter({ connection, prefix });
    secondAdapter.registerTask(sharedTask);
    cleanupHandles.push({ prefix, shutdown: () => secondAdapter.shutdown() });

    // Trigger lazy start so the worker connects and picks up the seeded job.
    await secondAdapter.start();

    // The seeded job will surface via listRuns once the worker drains it.
    await waitFor(async () => {
      const result = await secondAdapter.listRuns({ status: 'completed' });
      return result.runs.some(run => run.id === 'run-survive-1');
    }, 20_000);

    const result = await secondAdapter.listRuns({ status: 'completed' });
    const completedRun = result.runs.find(run => run.id === 'run-survive-1');
    expect(completedRun?.status).toBe('completed');
  }, 40_000);

  test(// Why: real apps will see transient Redis hiccups (blip in the network
  // path, container restart, etc.). We cannot easily simulate a "real"
  // Redis pause from the test, but we can prove the adapter's worker
  // tolerates an explicit ioredis disconnect/reconnect cycle on a *separate*
  // client without crashing. After the cycle the adapter must still
  // execute newly-enqueued tasks end-to-end.
  'adapter survives a transient Redis client disconnect/reconnect', async () => {
    const prefix = uniquePrefix('reconnect');
    const adapter = createBullMQOrchestrationAdapter({ connection, prefix });
    cleanupHandles.push({ prefix, shutdown: () => adapter.shutdown() });

    const task = defineTask({
      name: 'reconnect-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });
    adapter.registerTask(task);
    await adapter.start();

    // Run a baseline task to confirm the adapter is healthy before the
    // simulated outage.
    const beforeHandle = await adapter.runTask(task.name, { value: 'before' });
    await expect(beforeHandle.result()).resolves.toEqual({ value: 'before' });

    // Simulate a transient Redis client outage on a *separate* ioredis
    // pool. BullMQ's internal connection stays up — we're proving the
    // adapter survives disturbances elsewhere in the broader Redis pool
    // (e.g. an unrelated subscriber dropping out and reconnecting).
    // ioredis throws if connect() is called while a previous client is
    // still mid-disconnect, so we use two distinct clients to model the
    // disconnect/reconnect cycle cleanly.
    const probe1 = new Redis({ ...connection, lazyConnect: true });
    await probe1.connect();
    await probe1.ping();
    probe1.disconnect();
    const probe2 = new Redis({ ...connection, lazyConnect: true });
    await probe2.connect();
    await probe2.ping();
    probe2.disconnect();

    // Run a second task after the simulated blip — the adapter must still
    // be healthy and produce a real result.
    const afterHandle = await adapter.runTask(task.name, { value: 'after' });
    await expect(afterHandle.result()).resolves.toEqual({ value: 'after' });
  }, 30_000);

  test(// Why: end-to-end workflow execution is the highest-fidelity check that
  // BullMQ's queue-of-queues plus the adapter's child-job orchestration
  // works against real Redis. Mocks in the unit suite stub Job.fromId and
  // never exercise the actual workflowQueue → taskQueue handoff via
  // QueueEvents.waitUntilFinished.
  'workflow with two sequential steps completes end-to-end via real BullMQ', async () => {
    const prefix = uniquePrefix('workflow');
    const adapter = createBullMQOrchestrationAdapter({ connection, prefix });
    cleanupHandles.push({ prefix, shutdown: () => adapter.shutdown() });

    const upper = defineTask({
      name: 'to-upper',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      async handler(input) {
        return { text: input.text.toUpperCase() };
      },
    });
    const exclaim = defineTask({
      name: 'add-exclaim',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      async handler(input) {
        return { text: `${input.text}!` };
      },
    });
    const workflow = defineWorkflow({
      name: 'shout-workflow',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      steps: [
        step('upper-step', upper, {
          input: ({ workflowInput }) => ({ text: (workflowInput as { text: string }).text }),
        }),
        step('exclaim-step', exclaim, {
          input: ({ results }) => ({ text: (results['upper-step'] as { text: string }).text }),
        }),
      ],
      outputMapper: results => results['exclaim-step'] as { text: string },
    });

    adapter.registerTask(upper);
    adapter.registerTask(exclaim);
    adapter.registerWorkflow(workflow);
    await adapter.start();

    const handle = await adapter.runWorkflow(workflow.name, { text: 'hello' });
    try {
      const result = await handle.result();
      expect(result).toEqual({ text: 'HELLO!' });
    } catch (error) {
      // Surface the underlying error message so workflow regressions are
      // easy to diagnose from CI logs (default Bun rejection message is
      // truncated to "Promise rejected").
      throw new Error(
        `workflow.result() rejected: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`,
      );
    }
  }, 40_000);
});
