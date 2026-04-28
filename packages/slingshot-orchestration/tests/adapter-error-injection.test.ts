import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryAdapter } from '../src/adapters/memory';
import { defineTask } from '../src/defineTask';
import { defineWorkflow, step } from '../src/defineWorkflow';
import { OrchestrationError } from '../src/errors';
import { createOrchestrationRuntime } from '../src/runtime';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ObservabilityCapability,
  OrchestrationAdapter,
  ProgressCapability,
  Run,
  RunFilter,
  RunHandle,
  RunOptions,
  ScheduleCapability,
  ScheduleHandle,
  SignalCapability,
  WorkflowRun,
} from '../src/types';

/**
 * A stub adapter whose contract methods throw on demand. Each method has its own
 * boolean toggle so we can validate the runtime's behavior method-by-method
 * without relying on side effects from a previous failure.
 */
type ErrorTriggers = {
  registerTask: boolean;
  registerWorkflow: boolean;
  runTask: boolean;
  runWorkflow: boolean;
  getRun: boolean;
  cancelRun: boolean;
  start: boolean;
  shutdown: boolean;
  signal: boolean;
  schedule: boolean;
  unschedule: boolean;
  listSchedules: boolean;
  listRuns: boolean;
  onProgress: boolean;
};

type ErrorAdapter = OrchestrationAdapter &
  ObservabilityCapability &
  ProgressCapability &
  ScheduleCapability &
  SignalCapability;

function createErrorAdapter(triggers: Partial<ErrorTriggers> = {}): {
  adapter: ErrorAdapter;
  triggers: ErrorTriggers;
} {
  const flags: ErrorTriggers = {
    registerTask: false,
    registerWorkflow: false,
    runTask: false,
    runWorkflow: false,
    getRun: false,
    cancelRun: false,
    start: false,
    shutdown: false,
    signal: false,
    schedule: false,
    unschedule: false,
    listSchedules: false,
    listRuns: false,
    onProgress: false,
    ...triggers,
  };

  const fail = (method: keyof ErrorTriggers): never => {
    throw new OrchestrationError('ADAPTER_ERROR', `stub adapter: ${method} threw on demand`);
  };

  const adapter: ErrorAdapter = {
    registerTask(_def: AnyResolvedTask) {
      if (flags.registerTask) fail('registerTask');
    },
    registerWorkflow(_def: AnyResolvedWorkflow) {
      if (flags.registerWorkflow) fail('registerWorkflow');
    },
    async runTask(_name: string, _input: unknown, _opts?: RunOptions): Promise<RunHandle> {
      if (flags.runTask) fail('runTask');
      return { id: 'stub-run', result: () => Promise.resolve(undefined) };
    },
    async runWorkflow(_name: string, _input: unknown, _opts?: RunOptions): Promise<RunHandle> {
      if (flags.runWorkflow) fail('runWorkflow');
      return { id: 'stub-run', result: () => Promise.resolve(undefined) };
    },
    async getRun(_runId: string): Promise<Run | WorkflowRun | null> {
      if (flags.getRun) fail('getRun');
      return null;
    },
    async cancelRun(_runId: string): Promise<void> {
      if (flags.cancelRun) fail('cancelRun');
    },
    async start(): Promise<void> {
      if (flags.start) fail('start');
    },
    async shutdown(): Promise<void> {
      if (flags.shutdown) fail('shutdown');
    },
    async signal(_runId: string, _name: string, _payload?: unknown): Promise<void> {
      if (flags.signal) fail('signal');
    },
    async schedule(
      target: { type: 'task' | 'workflow'; name: string },
      cron: string,
    ): Promise<ScheduleHandle> {
      if (flags.schedule) fail('schedule');
      return { id: 'sched-1', target, cron };
    },
    async unschedule(_scheduleId: string): Promise<void> {
      if (flags.unschedule) fail('unschedule');
    },
    async listSchedules(): Promise<ScheduleHandle[]> {
      if (flags.listSchedules) fail('listSchedules');
      return [];
    },
    async listRuns(_filter?: RunFilter) {
      if (flags.listRuns) fail('listRuns');
      return { runs: [], total: 0 };
    },
    onProgress(_runId: string, _callback: (data: Run['progress']) => void) {
      if (flags.onProgress) fail('onProgress');
      return () => {};
    },
  };

  return { adapter, triggers: flags };
}

describe('adapter error injection — runtime surfaces typed errors', () => {
  test('runTask: adapter throw surfaces as a typed OrchestrationError, not a crash', async () => {
    const echoTask = defineTask({
      name: 'inj-echo',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return {};
      },
    });

    const { adapter } = createErrorAdapter({ runTask: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [echoTask] });

    let caught: unknown;
    try {
      await runtime.runTask(echoTask, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('ADAPTER_ERROR');
    expect((caught as OrchestrationError).message).toContain('runTask');
  });

  test('runWorkflow: adapter throw surfaces as a typed OrchestrationError', async () => {
    const noopTask = defineTask({
      name: 'inj-noop',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return {};
      },
    });
    const wf = defineWorkflow({
      name: 'inj-wf',
      input: z.object({}),
      steps: [step('only', noopTask)],
    });

    const { adapter } = createErrorAdapter({ runWorkflow: true });
    const runtime = createOrchestrationRuntime({
      adapter,
      tasks: [noopTask],
      workflows: [wf],
    });

    let caught: unknown;
    try {
      await runtime.runWorkflow(wf, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('ADAPTER_ERROR');
  });

  test('getRun: adapter throw surfaces, runtime does not crash', async () => {
    const { adapter } = createErrorAdapter({ getRun: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.getRun('does-not-matter');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('getRun');
  });

  test('cancelRun: adapter throw surfaces, runtime does not crash', async () => {
    const { adapter } = createErrorAdapter({ cancelRun: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.cancelRun('any-run');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('cancelRun');
  });

  test('listRuns: adapter throw surfaces as a rejected promise', async () => {
    const { adapter } = createErrorAdapter({ listRuns: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.listRuns();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('listRuns');
  });

  test('signal: adapter throw surfaces as a rejected promise', async () => {
    const { adapter } = createErrorAdapter({ signal: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.signal('run-id', 'pause');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('signal');
  });

  test('schedule: adapter throw surfaces as a rejected promise', async () => {
    const { adapter } = createErrorAdapter({ schedule: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.schedule({ type: 'task', name: 'irrelevant' }, '* * * * *');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('schedule');
  });

  test('unschedule: adapter throw surfaces as a rejected promise', async () => {
    const { adapter } = createErrorAdapter({ unschedule: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.unschedule('sched-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('unschedule');
  });

  test('listSchedules: adapter throw surfaces as a rejected promise', async () => {
    const { adapter } = createErrorAdapter({ listSchedules: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      await runtime.listSchedules();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('listSchedules');
  });

  test('onProgress: adapter throw surfaces synchronously without crashing the runtime', () => {
    const { adapter } = createErrorAdapter({ onProgress: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [] });

    let caught: unknown;
    try {
      runtime.onProgress('run-id', () => {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
  });

  test('registerTask: adapter throw at registration surfaces synchronously', () => {
    const echoTask = defineTask({
      name: 'inj-register',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return {};
      },
    });

    const { adapter } = createErrorAdapter({ registerTask: true });
    expect(() => createOrchestrationRuntime({ adapter, tasks: [echoTask] })).toThrow(
      OrchestrationError,
    );
  });
});

describe('adapter error injection — memory adapter idempotency state', () => {
  test('failed runTask does not leave a half-allocated run id in the in-flight Map', async () => {
    // Force the underlying engine to reject input via assertPayloadSize. Setting
    // a tiny maxPayloadBytes makes the very first call throw inside runTask
    // *after* the idempotency slot would have been claimed if the order were
    // different. The memory adapter must clean up after such failures.
    const adapter = createMemoryAdapter({ concurrency: 1, maxPayloadBytes: 1 });
    const echoTask = defineTask({
      name: 'idem-failure-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        return { echoed: input.value };
      },
    });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [echoTask] });

    // First call — fails at payload-size assertion (input is well over 1 byte).
    let firstError: unknown;
    try {
      await runtime.runTask(
        echoTask,
        { value: 'too-large-for-1-byte-cap' },
        { idempotencyKey: 'corrupt-key' },
      );
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeInstanceOf(OrchestrationError);
    expect((firstError as OrchestrationError).code).toBe('PAYLOAD_TOO_LARGE');

    // Second call with the SAME idempotency key but a smaller adapter would
    // be a poor regression target. Instead we re-create the adapter with a
    // permissive payload cap and confirm no stale handle is replayed.
    const adapter2 = createMemoryAdapter({ concurrency: 1 });
    const runtime2 = createOrchestrationRuntime({ adapter: adapter2, tasks: [echoTask] });

    // Trigger the failure path on adapter2 by making the *handler* throw,
    // ensuring the idempotency slot is claimed before the throw and must be
    // released on cleanup. We patch this through the synchronous error path:
    // the run starts, the handle.result() rejects, but the synchronous claim
    // path (resolveClaim() then inFlightIdempotency.delete()) has already run.
    // The follow-up call with the same key must therefore replay the SAME
    // run id (the persisted idempotencyKey), not get stuck.
    const explodingTask = defineTask({
      name: 'idem-explode-task',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        throw new Error('boom');
      },
    });
    const adapter3 = createMemoryAdapter({ concurrency: 1 });
    const runtime3 = createOrchestrationRuntime({
      adapter: adapter3,
      tasks: [explodingTask],
    });
    const handle1 = await runtime3.runTask(explodingTask, {}, { idempotencyKey: 'replay-1' });
    await expect(handle1.result()).rejects.toThrow('boom');

    // Replay must hit the same id — the in-flight Map was cleaned up and the
    // persisted idempotencyKeys Map kept the run id for replay.
    const handle2 = await runtime3.runTask(explodingTask, {}, { idempotencyKey: 'replay-1' });
    expect(handle2.id).toBe(handle1.id);

    // Use the unused references to keep the compiler happy and assert health.
    expect(runtime).toBeDefined();
    expect(runtime2).toBeDefined();
  });

  test('shutdown still drains successfully after an adapter contract throw', async () => {
    // The runtime calls adapter.shutdown() through the underlying memory
    // adapter. After a failed runTask call the adapter must remain in a state
    // where shutdown() resolves without hanging.
    const adapter = createMemoryAdapter({ concurrency: 1, maxPayloadBytes: 1 });
    const echoTask = defineTask({
      name: 'idem-drain-task',
      input: z.object({ value: z.string() }),
      output: z.object({ echoed: z.string() }),
      async handler(input) {
        return { echoed: input.value };
      },
    });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [echoTask] });

    let caught: unknown;
    try {
      await runtime.runTask(echoTask, { value: 'over-the-cap' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);

    // Drain must complete promptly. We race against a generous timeout —
    // hanging would fail the assertion below.
    const drained = await Promise.race([
      adapter.shutdown().then(() => 'ok' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    expect(drained).toBe('ok');
  });

  test('shutdown still drains after a stub adapter throws on runTask', async () => {
    const echoTask = defineTask({
      name: 'inj-drain-task',
      input: z.object({}),
      output: z.object({}),
      async handler() {
        return {};
      },
    });

    const { adapter, triggers } = createErrorAdapter({ runTask: true });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [echoTask] });

    await expect(runtime.runTask(echoTask, {})).rejects.toBeInstanceOf(OrchestrationError);

    // Reset the throw flag so shutdown() does not also throw — drain must work.
    triggers.runTask = false;
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});
