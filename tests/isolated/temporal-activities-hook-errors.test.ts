/**
 * Isolated unit tests for slingshot-orchestration-temporal activities —
 * specifically hook error propagation in executeWorkflowHook.
 *
 * Must run in an isolated bun test invocation to avoid mock.module leakage
 * (worker.test.ts mocks '../src/activities' which would contaminate this file
 * if run in the same process):
 *
 *   bun test tests/isolated/temporal-activities-hook-errors.test.ts
 *
 * No Temporal server required.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock @temporalio/activity so the module loads outside a real worker sandbox
// ---------------------------------------------------------------------------

const fakeActivityInfo = {
  attempt: 1,
  currentAttemptScheduledTimestampMs: Date.now(),
};

mock.module('@temporalio/activity', () => ({
  Context: {
    current() {
      return {
        info: fakeActivityInfo,
        cancellationSignal: undefined,
      };
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock @temporalio/client — provide all named exports that src files import
// ---------------------------------------------------------------------------

class FakeWorkflowHandleForActivity {
  signals: Array<{ name: string; payload?: unknown }> = [];

  async signal(name: string, payload?: unknown) {
    this.signals.push({ name, payload });
  }
}

class FakeClientForActivity {
  handle = new FakeWorkflowHandleForActivity();

  workflow = {
    getHandle: (_workflowId: string) => this.handle,
  };
}

mock.module('@temporalio/client', () => {
  class WorkflowFailedError extends Error {
    cause: unknown;
    constructor(message: string, cause: unknown) {
      super(message);
      this.name = 'WorkflowFailedError';
      this.cause = cause;
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
    timeoutType: string;
    lastHeartbeatDetails: unknown;
    constructor(message: string, lastHeartbeatDetails: unknown, timeoutType: string) {
      super(message);
      this.name = 'TimeoutFailure';
      this.timeoutType = timeoutType;
      this.lastHeartbeatDetails = lastHeartbeatDetails;
    }
  }

  class ScheduleNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ScheduleNotFoundError';
    }
  }

  return {
    Client: class {
      workflow: FakeClientForActivity['workflow'];
      constructor() {
        const inner = new FakeClientForActivity();
        this.workflow = inner.workflow;
      }
    },
    WorkflowFailedError,
    ApplicationFailure,
    CancelledFailure,
    TerminatedFailure,
    TimeoutFailure,
    ScheduleNotFoundError,
  };
});

// ---------------------------------------------------------------------------
// Mock ../src/workerRegistry (relative to the package)
// ---------------------------------------------------------------------------

let registeredHooks: Record<
  string,
  {
    onStart?: (payload: unknown) => Promise<void>;
    onComplete?: (payload: unknown) => Promise<void>;
    onFail?: (payload: unknown) => Promise<void>;
  }
> = {};

mock.module(
  '../../packages/slingshot-orchestration-temporal/src/workerRegistry',
  () => ({
    getRegisteredTask: mock((name: string) => {
      if (name === 'registered-task') {
        return {
          name: 'registered-task',
          concurrency: undefined,
          input: { parse: (v: unknown) => v },
          output: { parse: (v: unknown) => v },
          handler: async (_input: unknown) => ({ result: 'ok' }),
        };
      }
      return undefined;
    }),
    getRegisteredWorkflowHooks: mock((name: string) => {
      return registeredHooks[name];
    }),
  }),
);

let createTemporalActivities: (typeof import('../../packages/slingshot-orchestration-temporal/src/activities'))['createTemporalActivities'];

beforeAll(async () => {
  const mod = await import(
    '../../packages/slingshot-orchestration-temporal/src/activities'
  );
  createTemporalActivities = mod.createTemporalActivities;
});

// ---------------------------------------------------------------------------
// Hook error propagation tests
// ---------------------------------------------------------------------------

describe('executeWorkflowHook — hook error propagation', () => {
  const fakeConnection = {
    address: 'localhost:7233',
    credentials: {},
    options: {},
    ensureConnected: async () => {},
  } as never;

  test('onComplete hook that throws causes the activity to throw (after logging)', async () => {
    const hookError = new Error('completion hook exploded');
    registeredHooks['my-workflow'] = {
      onComplete: async () => {
        throw hookError;
      },
    };

    const loggedErrors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    const activities = createTemporalActivities({
      connection: fakeConnection,
    });

    try {
      await expect(
        activities.executeWorkflowHook({
          workflowName: 'my-workflow',
          hook: 'onComplete',
          payload: { runId: 'run-1', output: {}, durationMs: 0 },
          runId: 'run-1',
        }),
      ).rejects.toThrow('completion hook exploded');

      // Error should have been logged before rethrowing
      expect(loggedErrors.length).toBeGreaterThan(0);
    } finally {
      console.error = origError;
    }
  });

  test('onFail hook that throws causes the activity to throw (after logging)', async () => {
    const hookError = new Error('fail hook exploded');
    registeredHooks['fail-workflow'] = {
      onFail: async () => {
        throw hookError;
      },
    };

    const loggedErrors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    const activities = createTemporalActivities({
      connection: fakeConnection,
    });

    try {
      await expect(
        activities.executeWorkflowHook({
          workflowName: 'fail-workflow',
          hook: 'onFail',
          payload: { runId: 'run-2', error: new Error('step failed'), failedStep: 'step-1' },
          runId: 'run-2',
        }),
      ).rejects.toThrow('fail hook exploded');

      expect(loggedErrors.length).toBeGreaterThan(0);
    } finally {
      console.error = origError;
    }
  });

  test('hook that succeeds does not throw', async () => {
    let called = false;
    registeredHooks['success-workflow'] = {
      onStart: async () => {
        called = true;
      },
    };

    const activities = createTemporalActivities({
      connection: fakeConnection,
    });

    await expect(
      activities.executeWorkflowHook({
        workflowName: 'success-workflow',
        hook: 'onStart',
        payload: { runId: 'run-3', input: {} },
        runId: 'run-3',
      }),
    ).resolves.toBeUndefined();

    expect(called).toBe(true);
  });

  test('missing hook returns without throwing', async () => {
    registeredHooks['no-hook-workflow'] = {}; // no hooks registered

    const activities = createTemporalActivities({
      connection: fakeConnection,
    });

    await expect(
      activities.executeWorkflowHook({
        workflowName: 'no-hook-workflow',
        hook: 'onComplete',
        payload: {},
        runId: 'run-4',
      }),
    ).resolves.toBeUndefined();
  });

  test('eventSink.emit is called before rethrowing when hook throws', async () => {
    const hookError = new Error('hook boom');
    registeredHooks['emit-workflow'] = {
      onComplete: async () => {
        throw hookError;
      },
    };

    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    const origError = console.error;
    console.error = () => {};

    const activities = createTemporalActivities({
      connection: fakeConnection,
      eventSink: {
        emit: async (name, payload) => {
          emittedEvents.push({ name, payload });
        },
      },
    });

    try {
      await activities.executeWorkflowHook({
        workflowName: 'emit-workflow',
        hook: 'onComplete',
        payload: {},
        runId: 'run-5',
      });
    } catch {
      // expected
    } finally {
      console.error = origError;
    }

    expect(emittedEvents.some(e => e.name === 'orchestration.workflow.hookError')).toBe(true);
  });
});
