/**
 * Verifies that the internal `Client` constructed inside
 * `createTemporalActivities()` receives the same `dataConverter` and
 * `interceptors` that the worker was configured with.
 *
 * The activities-side `Client` is used to send signals from activities back
 * into the parent workflow (e.g. `slingshot-progress`). Without codec
 * symmetry, those signal payloads bypass the payload codec installed on the
 * server-side `Client` and the `Worker`, leaking unredacted PII to Temporal
 * Web UI and the visibility store.
 *
 * Lives under `tests/unit/` to keep the file isolatable from other tests in
 * the package — top-level `mock.module()` calls in this file would otherwise
 * leak into co-process tests in the same Bun invocation. The file is
 * therefore registered as its own suite in `scripts/workspace-test-suites.ts`
 * and excluded from the recursively-collected package suite.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Capture every Client constructor call so we can assert the activities-side
// Client receives the codec and interceptors plumbed through worker options.
// ---------------------------------------------------------------------------

interface CapturedClientOptions {
  connection?: unknown;
  namespace?: string;
  dataConverter?: unknown;
  interceptors?: unknown;
}

const capturedClientOptions: CapturedClientOptions[] = [];
const capturedHandleIds: string[] = [];
const capturedSignals: Array<{ name: string; payload: unknown }> = [];
const abortController = new AbortController();

let currentActivityContext = {
  info: { attempt: 1, currentAttemptScheduledTimestampMs: Date.now() - 25 },
  cancellationSignal: abortController.signal,
};

// Activities transitively imports `errors.ts` which pulls several named
// failure classes from `@temporalio/client`. Provide stubs for every named
// export the package source touches so the mocked module satisfies all
// transitive imports (otherwise Bun raises `Export named 'X' not found`).
mock.module('@temporalio/client', () => {
  class WorkflowFailedError extends Error {
    cause: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = 'WorkflowFailedError';
      this.cause = cause;
    }
  }
  class CancelledFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CancelledFailure';
    }
  }
  class TerminatedFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TerminatedFailure';
    }
  }
  class TimeoutFailure extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TimeoutFailure';
    }
  }
  class ApplicationFailure extends Error {
    details: unknown[];
    constructor(message: string, _type?: string, ...details: unknown[]) {
      super(message);
      this.name = 'ApplicationFailure';
      this.details = details;
    }
  }
  class ScheduleNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ScheduleNotFoundError';
    }
  }

  return {
    Client: class FakeClient {
      workflow = {
        getHandle: (workflowId: string) => ({
          async signal(name: string, payload: unknown) {
            capturedHandleIds.push(workflowId);
            capturedSignals.push({ name, payload });
          },
        }),
      };
      constructor(options: CapturedClientOptions) {
        capturedClientOptions.push(options);
      }
    },
    WorkflowFailedError,
    CancelledFailure,
    TerminatedFailure,
    TimeoutFailure,
    ApplicationFailure,
    ScheduleNotFoundError,
  };
});

mock.module('@temporalio/activity', () => ({
  Context: {
    current() {
      return currentActivityContext;
    },
  },
}));

const { createTemporalActivities } = await import('../../src/activities');
const { clearWorkerRegistries, installWorkerRegistries } = await import('../../src/workerRegistry');

beforeEach(() => {
  capturedClientOptions.length = 0;
  capturedHandleIds.length = 0;
  capturedSignals.length = 0;
  currentActivityContext = {
    info: { attempt: 2, currentAttemptScheduledTimestampMs: Date.now() - 50 },
    cancellationSignal: abortController.signal,
  };
  clearWorkerRegistries();
});

afterEach(() => {
  clearWorkerRegistries();
});

describe('createTemporalActivities — codec/interceptor plumbing', () => {
  test('forwards dataConverter and interceptors into the internal Client', () => {
    const dataConverter = { payloadConverterPath: '/tmp/payload-converter.ts' };
    const interceptors = {
      workflow: [{ create: () => ({}) }],
    };
    const connection = { fake: true } as never;

    createTemporalActivities({
      connection,
      namespace: 'tenant-a',
      dataConverter: dataConverter as never,
      interceptors: interceptors as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.connection).toBe(connection);
    expect(opts.namespace).toBe('tenant-a');
    expect(opts.dataConverter).toBe(dataConverter);
    expect(opts.interceptors).toBe(interceptors);
  });

  test('omits dataConverter and interceptors when the caller does not provide them', () => {
    createTemporalActivities({
      connection: { fake: true } as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.dataConverter).toBeUndefined();
    expect(opts.interceptors).toBeUndefined();
    // Namespace is also optional and must not appear when unset, so
    // `Client` falls back to its `'default'` default.
    expect(opts.namespace).toBeUndefined();
  });

  test('forwards only dataConverter when interceptors are unset', () => {
    const dataConverter = { payloadConverterPath: '/tmp/pc.ts' };

    createTemporalActivities({
      connection: { fake: true } as never,
      dataConverter: dataConverter as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.dataConverter).toBe(dataConverter);
    expect(opts.interceptors).toBeUndefined();
  });

  test('forwards only interceptors when dataConverter is unset', () => {
    const interceptors = { workflow: [{ create: () => ({}) }] };

    createTemporalActivities({
      connection: { fake: true } as never,
      interceptors: interceptors as never,
    });

    expect(capturedClientOptions).toHaveLength(1);
    const opts = capturedClientOptions[0]!;
    expect(opts.interceptors).toBe(interceptors);
    expect(opts.dataConverter).toBeUndefined();
  });

  test('executes a registered task with parsed input, progress signals, and lifecycle events', async () => {
    const handler = mock(async (input: { value: number }, ctx) => {
      expect(input).toEqual({ value: 3 });
      expect(ctx.attempt).toBe(2);
      expect(ctx.runId).toBe('run-1');
      expect(ctx.tenantId).toBe('tenant-a');
      expect(ctx.signal).toBe(abortController.signal);
      ctx.reportProgress({ percent: 50, message: 'halfway' });
      return { doubled: input.value * 2 };
    });
    const eventSink = {
      emit: mock(async (name: string, payload: unknown) => {
        emittedEvents.push({ name, payload });
      }),
    };
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];

    installWorkerRegistries({
      tasks: [
        {
          _tag: 'ResolvedTask',
          name: 'double-number',
          input: { parse: (value: unknown) => value },
          output: { parse: (value: unknown) => value },
          handler,
          concurrency: 1,
        },
      ] as never,
      workflows: [],
    });

    const activities = createTemporalActivities({
      connection: { fake: true } as never,
      eventSink: eventSink as never,
    });

    await expect(
      activities.executeSlingshotTask({
        taskName: 'double-number',
        input: { value: 3 },
        runId: 'run-1',
        tenantId: 'tenant-a',
        parentWorkflowId: 'workflow-1',
        stepName: 'double',
      }),
    ).resolves.toEqual({ output: { doubled: 6 }, attempts: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(capturedHandleIds).toEqual(['workflow-1']);
    expect(capturedSignals).toEqual([
      {
        name: 'slingshot-progress',
        payload: { stepName: 'double', data: { percent: 50, message: 'halfway' } },
      },
    ]);
    expect(emittedEvents.map(event => event.name)).toEqual([
      'orchestration.task.started',
      'orchestration.task.progress',
      'orchestration.task.completed',
    ]);
    expect(emittedEvents[0]!.payload).toMatchObject({
      runId: 'run-1',
      task: 'double-number',
      input: { value: 3 },
      tenantId: 'tenant-a',
    });
    expect(emittedEvents[2]!.payload).toMatchObject({
      runId: 'run-1',
      task: 'double-number',
      output: { doubled: 6 },
      tenantId: 'tenant-a',
    });
  });

  test('emits a failed task event and rethrows handler errors', async () => {
    const error = new Error('boom');
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    installWorkerRegistries({
      tasks: [
        {
          _tag: 'ResolvedTask',
          name: 'explode',
          input: { parse: (value: unknown) => value },
          output: { parse: (value: unknown) => value },
          handler: mock(async () => {
            throw error;
          }),
        },
      ] as never,
      workflows: [],
    });

    const activities = createTemporalActivities({
      connection: { fake: true } as never,
      eventSink: {
        emit: mock(async (name: string, payload: unknown) => {
          emittedEvents.push({ name, payload });
        }),
      } as never,
    });

    await expect(
      activities.executeSlingshotTask({
        taskName: 'explode',
        input: { value: 1 },
        runId: 'run-2',
        parentWorkflowId: 'workflow-2',
      }),
    ).rejects.toThrow('boom');

    expect(emittedEvents.map(event => event.name)).toEqual([
      'orchestration.task.started',
      'orchestration.task.failed',
    ]);
    expect(emittedEvents[1]!.payload).toMatchObject({
      runId: 'run-2',
      task: 'explode',
      error: { message: 'boom' },
    });
  });

  test('rejects unregistered tasks before emitting task lifecycle events', async () => {
    const eventSink = { emit: mock(async () => {}) };
    const activities = createTemporalActivities({
      connection: { fake: true } as never,
      eventSink: eventSink as never,
    });

    await expect(
      activities.executeSlingshotTask({
        taskName: 'missing',
        input: {},
        runId: 'run-missing',
        parentWorkflowId: 'workflow-missing',
      }),
    ).rejects.toThrow("Task 'missing' is not registered in the Temporal worker.");
    expect(eventSink.emit).not.toHaveBeenCalled();
  });

  test('runs workflow hooks, no-ops missing hooks, and emits hook failures', async () => {
    const onStart = mock(async (payload: { runId: string }) => {
      expect(payload).toEqual({ runId: 'run-3' });
    });
    const hookError = new Error('hook failed');
    const onFail = mock(async () => {
      throw hookError;
    });
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    const originalConsoleError = console.error;
    console.error = mock(() => {}) as never;

    installWorkerRegistries({
      tasks: [],
      workflows: [
        {
          _tag: 'ResolvedWorkflow',
          name: 'welcome-flow',
          onStart,
          onFail,
        },
      ] as never,
    });

    const activities = createTemporalActivities({
      connection: { fake: true } as never,
      eventSink: {
        emit: mock(async (name: string, payload: unknown) => {
          emittedEvents.push({ name, payload });
        }),
      } as never,
    });

    try {
      await activities.executeWorkflowHook({
        workflowName: 'welcome-flow',
        hook: 'onStart',
        payload: { runId: 'run-3' },
        runId: 'run-3',
      });
      await activities.executeWorkflowHook({
        workflowName: 'welcome-flow',
        hook: 'onComplete',
        payload: {},
        runId: 'run-3',
      });
      await activities.executeWorkflowHook({
        workflowName: 'missing-flow',
        hook: 'onStart',
        payload: {},
        runId: 'run-3',
      });

      await expect(
        activities.executeWorkflowHook({
          workflowName: 'welcome-flow',
          hook: 'onFail',
          payload: {},
          runId: 'run-3',
        }),
      ).rejects.toThrow('hook failed');
    } finally {
      console.error = originalConsoleError;
    }

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(emittedEvents).toEqual([
      {
        name: 'orchestration.workflow.hookError',
        payload: expect.objectContaining({
          runId: 'run-3',
          workflow: 'welcome-flow',
          hook: 'onFail',
          error: expect.objectContaining({ message: 'hook failed' }),
        }),
      },
    ]);
  });

  test('emits arbitrary orchestration events through the configured sink', async () => {
    const eventSink = { emit: mock(async () => {}) };
    const activities = createTemporalActivities({
      connection: { fake: true } as never,
      eventSink: eventSink as never,
    });

    await activities.emitOrchestrationEvent({
      name: 'orchestration.workflow.started',
      payload: { runId: 'run-4', workflow: 'welcome-flow', input: {} },
    });

    expect(eventSink.emit).toHaveBeenCalledWith('orchestration.workflow.started', {
      runId: 'run-4',
      workflow: 'welcome-flow',
      input: {},
    });
  });
});
