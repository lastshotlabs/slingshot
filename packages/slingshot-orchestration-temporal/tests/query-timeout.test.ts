/**
 * P-TEMPORAL-5 / P-TEMPORAL-6: verify the query-state poll has a finite
 * timeout and the optional onQuery / onSignal instrumentation hooks fire
 * with `{ runId, durationMs, error? }` on every adapter query/signal.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

interface FakeHandle {
  workflowId: string;
  describe(): Promise<unknown>;
  result(): Promise<unknown>;
  cancel(): Promise<void>;
  signal(name: string, payload?: unknown): Promise<void>;
  query<T>(name: string): Promise<T>;
}

const fakeHandles = new Map<string, FakeHandle>();

function makeHandle(workflowId: string, options?: Partial<FakeHandle>): FakeHandle {
  const handle: FakeHandle = {
    workflowId,
    async describe() {
      return {
        memo: { kind: 'task', name: 'fake-task', input: {} },
        status: { name: 'COMPLETED' },
        startTime: new Date(),
      };
    },
    async result() {
      return { output: 'ok' };
    },
    async cancel() {},
    async signal() {},
    async query() {
      return { progress: undefined, steps: undefined } as never;
    },
    ...options,
  };
  fakeHandles.set(workflowId, handle);
  return handle;
}

const fakeClient = {
  workflow: {
    getHandle: (workflowId: string) => fakeHandles.get(workflowId) ?? makeHandle(workflowId),
  },
};

let createTemporalOrchestrationAdapter: (typeof import('../src/adapter'))['createTemporalOrchestrationAdapter'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createTemporalOrchestrationAdapter = mod.createTemporalOrchestrationAdapter;
});

beforeEach(() => {
  fakeHandles.clear();
});

describe('temporal query timeout (P-TEMPORAL-5)', () => {
  test('maybeQueryState times out hung handle.query() instead of hanging forever', async () => {
    // Install a handle whose query() never resolves — without the timeout
    // the adapter would block indefinitely waiting for the cluster to reply.
    const runId = 'task-run-hang';
    makeHandle(runId, {
      async query() {
        return new Promise(() => undefined) as never;
      },
    });

    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      queryTimeoutMs: 50,
    });

    const startedAt = Date.now();
    const run = await adapter.getRun(runId);
    const elapsed = Date.now() - startedAt;

    // The timeout returns undefined for state and the run still resolves; the
    // critical guarantee is that we do not block past the configured budget.
    expect(elapsed).toBeLessThan(1_000);
    expect(run).not.toBeNull();
  });

  test('caps concurrent in-flight queries at 1 per runId', async () => {
    const runId = 'task-run-concurrent';
    let queryCount = 0;
    let resolveQuery: ((value: unknown) => void) | null = null;
    makeHandle(runId, {
      async query() {
        queryCount += 1;
        return new Promise(resolve => {
          resolveQuery = resolve;
        }) as never;
      },
    });

    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      queryTimeoutMs: 5_000,
    });

    // Three concurrent getRun calls all resolve their query through a single
    // shared in-flight promise. Without coalescing each call would have
    // started its own query() call.
    const calls = [adapter.getRun(runId), adapter.getRun(runId), adapter.getRun(runId)];

    // Allow microtasks to flush so the adapter has a chance to stack the
    // concurrent callers behind the same in-flight promise.
    await new Promise(r => setTimeout(r, 10));
    expect(queryCount).toBe(1);

    if (resolveQuery) {
      resolveQuery({ progress: undefined, steps: undefined });
    }
    await Promise.all(calls);
  });
});

describe('temporal instrumentation hooks (P-TEMPORAL-6)', () => {
  test('onQuery fires with runId and durationMs on successful query', async () => {
    const runId = 'task-run-onquery';
    makeHandle(runId);

    const events: Array<{ runId: string; durationMs: number; error?: unknown }> = [];
    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      onQuery: event => {
        events.push(event);
      },
    });

    await adapter.getRun(runId);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.runId).toBe(runId);
    expect(typeof events[0]?.durationMs).toBe('number');
    expect(events[0]?.error).toBeUndefined();
  });

  test('onQuery fires with the error attached on query failure', async () => {
    const runId = 'task-run-onquery-fail';
    makeHandle(runId, {
      async query() {
        throw new Error('temporal disconnected');
      },
    });

    const events: Array<{ runId: string; durationMs: number; error?: unknown }> = [];
    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      onQuery: event => {
        events.push(event);
      },
    });

    await adapter.getRun(runId);
    expect(events.length).toBeGreaterThan(0);
    expect((events[0]?.error as Error)?.message).toBe('temporal disconnected');
  });

  test('onSignal fires with runId and durationMs on successful signal', async () => {
    const runId = 'workflow-onsignal';
    makeHandle(runId, {
      async describe() {
        return {
          memo: { kind: 'workflow', name: 'fake-workflow', input: {} },
          status: { name: 'RUNNING' },
          startTime: new Date(),
        };
      },
    });

    const events: Array<{ runId: string; durationMs: number; error?: unknown }> = [];
    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      onSignal: event => {
        events.push(event);
      },
    });

    await adapter.signal(runId, 'wakeup', { hello: 'world' });
    expect(events.length).toBe(1);
    expect(events[0]?.runId).toBe(runId);
    expect(events[0]?.error).toBeUndefined();
  });

  test('onSignal fires with the error on signal failure and the error rethrows', async () => {
    const runId = 'workflow-onsignal-fail';
    makeHandle(runId, {
      async describe() {
        return {
          memo: { kind: 'workflow', name: 'fake-workflow', input: {} },
          status: { name: 'RUNNING' },
          startTime: new Date(),
        };
      },
      async signal() {
        throw new Error('signal rejected');
      },
    });

    const events: Array<{ runId: string; durationMs: number; error?: unknown }> = [];
    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      onSignal: event => {
        events.push(event);
      },
    });

    await expect(adapter.signal(runId, 'wakeup', {})).rejects.toThrow('signal rejected');
    expect(events.length).toBe(1);
    expect((events[0]?.error as Error)?.message).toBe('signal rejected');
  });
});
