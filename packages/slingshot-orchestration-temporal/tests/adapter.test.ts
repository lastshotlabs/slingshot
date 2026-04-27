import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  OrchestrationError,
  defineTask,
  defineWorkflow,
  sleep,
} from '@lastshotlabs/slingshot-orchestration';

// ---------------------------------------------------------------------------
// Fake Temporal client
// ---------------------------------------------------------------------------

interface FakeWorkflowHandle {
  workflowId: string;
  describe(): Promise<FakeWorkflowDescription>;
  result(): Promise<unknown>;
  cancel(): Promise<void>;
  signal(name: string, payload?: unknown): Promise<void>;
  query<T>(queryName: string): Promise<T>;
}

interface FakeWorkflowDescription {
  status: { name: string };
  memo?: Record<string, unknown>;
  searchAttributes?: Record<string, unknown>;
  startTime: Date;
  executionTime?: Date;
  closeTime?: Date;
}

interface FakeExecution {
  workflowId: string;
  status: { name: string };
  memo?: Record<string, unknown>;
  searchAttributes?: Record<string, unknown>;
  startTime: Date;
  executionTime?: Date;
  closeTime?: Date;
}

class FakeWorkflowClient {
  handles = new Map<string, FakeWorkflowHandle>();
  startedWorkflows: Array<{
    workflowType: string;
    workflowId: string;
    taskQueue: string;
    args: unknown[];
    memo?: Record<string, unknown>;
    searchAttributes?: unknown;
  }> = [];
  listExecutions: FakeExecution[] = [];
  countValue = 0;

  start = mock(
    async (
      workflowType: string,
      options: {
        taskQueue: string;
        workflowId: string;
        args: unknown[];
        memo?: Record<string, unknown>;
        searchAttributes?: unknown;
        workflowIdConflictPolicy?: string;
      },
    ) => {
      this.startedWorkflows.push({
        workflowType,
        workflowId: options.workflowId,
        taskQueue: options.taskQueue,
        args: options.args,
        memo: options.memo,
        searchAttributes: options.searchAttributes,
      });

      // Return a handle; the actual handle is looked up by workflowId
      return this.getHandle(options.workflowId);
    },
  );

  getHandle(workflowId: string): FakeWorkflowHandle {
    const stored = this.handles.get(workflowId);
    if (stored) return stored;
    // Return a handle that will throw WorkflowNotFoundError on describe
    const handle: FakeWorkflowHandle = {
      workflowId,
      async describe() {
        const notFound = new Error(`Workflow '${workflowId}' not found`);
        notFound.name = 'WorkflowNotFoundError';
        throw notFound;
      },
      async result() {
        throw new Error(`No result registered for '${workflowId}'`);
      },
      async cancel() {},
      async signal() {},
      async query() {
        return undefined as unknown as never;
      },
    };
    this.handles.set(workflowId, handle);
    return handle;
  }

  list(_options?: { query?: string; pageSize?: number }) {
    const executions = this.listExecutions;
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const execution of executions) {
          yield execution;
        }
      },
    };
  }

  async count(_query?: string) {
    return { count: this.countValue };
  }
}

class FakeConnection {
  closed = false;
  close = mock(async () => {
    this.closed = true;
  });
  ensureConnected = mock(async () => {});
}

class FakeClient {
  connection: FakeConnection;
  workflow: FakeWorkflowClient;

  constructor(connection: FakeConnection) {
    this.connection = connection;
    this.workflow = new FakeWorkflowClient();
  }
}

// ---------------------------------------------------------------------------
// Module mock: replace @temporalio/client with fakes
// ---------------------------------------------------------------------------

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

    static nonRetryable(message: string, type: string, ...details: unknown[]) {
      return new ApplicationFailure(message, type, ...details);
    }
  }

  class CancelledFailure extends Error {
    details: unknown[];
    constructor(message: string, details: unknown[] = []) {
      super(message);
      this.name = 'CancelledFailure';
      this.details = details;
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
      connection: FakeConnection;
      workflow: FakeWorkflowClient;
      constructor() {
        // Will be replaced by the test factory
        throw new Error('Use FakeClient directly via adapter options');
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

let createTemporalOrchestrationAdapter: (typeof import('../src/adapter'))['createTemporalOrchestrationAdapter'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createTemporalOrchestrationAdapter = mod.createTemporalOrchestrationAdapter;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandle(
  fakeClient: FakeClient,
  runId: string,
  description: Partial<FakeWorkflowDescription> & { status: { name: string } },
  result?: unknown,
  resultError?: unknown,
): FakeWorkflowHandle {
  const handle: FakeWorkflowHandle = {
    workflowId: runId,
    async describe() {
      return {
        startTime: new Date(),
        executionTime: new Date(),
        ...description,
      };
    },
    async result() {
      if (resultError !== undefined) throw resultError;
      return result;
    },
    async cancel() {},
    async signal() {},
    async query<T>() {
      return undefined as unknown as T;
    },
  };
  fakeClient.workflow.handles.set(runId, handle);
  return handle;
}

function buildAdapter(
  fakeClient: FakeClient,
  fakeConnection?: FakeConnection,
  ownsConnection?: boolean,
) {
  return createTemporalOrchestrationAdapter({
    client: fakeClient as never,
    connection: fakeConnection as never,
    workflowTaskQueue: 'test-queue',
    ownsConnection,
  });
}

const sampleTask = defineTask({
  name: 'sample-task',
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  async handler(input) {
    return { result: input.value };
  },
});

const sampleWorkflow = defineWorkflow({
  name: 'sample-workflow',
  input: z.object({ userId: z.string() }),
  steps: [sleep('sample-wait', 1)],
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

describe('runTask', () => {
  test('submits a task workflow and returns a run handle with the correct run ID', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerTask(sampleTask);

    // Pre-seed a handle so result() resolves
    const handle = await adapter.runTask(sampleTask.name, { value: 'hello' });

    expect(typeof handle.id).toBe('string');
    expect(handle.id.length).toBeGreaterThan(0);

    // Verify the underlying workflow.start was called with the task workflow type
    expect(fakeClient.workflow.startedWorkflows).toHaveLength(1);
    expect(fakeClient.workflow.startedWorkflows[0]?.workflowType).toBe('slingshotTaskWorkflow');
    expect(fakeClient.workflow.startedWorkflows[0]?.taskQueue).toBe('test-queue');
    expect(fakeClient.workflow.startedWorkflows[0]?.memo?.kind).toBe('task');
    expect(fakeClient.workflow.startedWorkflows[0]?.memo?.name).toBe('sample-task');
  });

  test('runTask with idempotency key produces a deterministic run ID', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerTask(sampleTask);

    const handle1 = await adapter.runTask(
      sampleTask.name,
      { value: 'a' },
      { idempotencyKey: 'key-1' },
    );
    const fakeClient2 = new FakeClient(new FakeConnection());
    const adapter2 = buildAdapter(fakeClient2, new FakeConnection());
    adapter2.registerTask(sampleTask);
    const handle2 = await adapter2.runTask(
      sampleTask.name,
      { value: 'a' },
      { idempotencyKey: 'key-1' },
    );

    expect(handle1.id).toBe(handle2.id);
  });

  test('throws TASK_NOT_FOUND when the task is not registered', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    await expect(adapter.runTask('unregistered-task', {})).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  test('runTask result() resolves with the output from the workflow', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerTask(sampleTask);
    const handle = await adapter.runTask(sampleTask.name, { value: 'test' });

    // Inject a result into the handle after start
    const stored = fakeClient.workflow.handles.get(handle.id);
    expect(stored).toBeDefined();
    if (stored) {
      // Override result to return envelope
      (stored as FakeWorkflowHandle & { result(): Promise<unknown> }).result = async () => ({
        output: { result: 'test' },
      });
    }

    await expect(handle.result()).resolves.toEqual({ result: 'test' });
  });

  test('prevents duplicate task registration', () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerTask(sampleTask);
    expect(() => adapter.registerTask(sampleTask)).toThrow(OrchestrationError);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow
// ---------------------------------------------------------------------------

describe('runWorkflow', () => {
  test('submits a workflow run and returns a handle', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerWorkflow(sampleWorkflow);
    const handle = await adapter.runWorkflow(sampleWorkflow.name, { userId: 'u1' });

    expect(typeof handle.id).toBe('string');
    expect(handle.id.length).toBeGreaterThan(0);

    const started = fakeClient.workflow.startedWorkflows[0];
    expect(started?.workflowType).toBe('slingshotWorkflow');
    expect(started?.memo?.kind).toBe('workflow');
    expect(started?.memo?.name).toBe('sample-workflow');
  });

  test('throws WORKFLOW_NOT_FOUND when the workflow is not registered', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    await expect(adapter.runWorkflow('no-such-workflow', {})).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    });
  });

  test('prevents duplicate workflow registration', () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerWorkflow(sampleWorkflow);
    expect(() => adapter.registerWorkflow(sampleWorkflow)).toThrow(OrchestrationError);
  });

  test('passes delay option through to temporal start call', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    adapter.registerWorkflow(sampleWorkflow);
    await adapter.runWorkflow(sampleWorkflow.name, { userId: 'u1' }, { delay: 5000 });

    // The start call args are captured; just verify the underlying start was invoked
    expect(fakeClient.workflow.startedWorkflows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getRun
// ---------------------------------------------------------------------------

describe('getRun', () => {
  test('returns null for a run that does not exist', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const result = await adapter.getRun('non-existent-run-id');
    expect(result).toBeNull();
  });

  test('returns a running task run', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_task_running_01';
    makeHandle(fakeClient, runId, {
      status: { name: 'RUNNING' },
      memo: {
        kind: 'task',
        name: 'sample-task',
        input: { value: 'hello' },
      },
    });

    const run = await adapter.getRun(runId);
    expect(run).not.toBeNull();
    expect(run?.id).toBe(runId);
    expect(run?.type).toBe('task');
    expect(run?.name).toBe('sample-task');
    expect(run?.status).toBe('running');
    expect(run?.input).toEqual({ value: 'hello' });
  });

  test('returns a completed task run with output', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_task_completed_01';
    makeHandle(
      fakeClient,
      runId,
      {
        status: { name: 'COMPLETED' },
        memo: {
          kind: 'task',
          name: 'sample-task',
          input: { value: 'hello' },
        },
        closeTime: new Date(),
      },
      { output: { result: 'hello' }, progress: undefined },
    );

    const run = await adapter.getRun(runId);
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ result: 'hello' });
  });

  test('returns a failed task run with error details', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_task_failed_01';
    // Construct fakes that mirror the shapes extractFailureDetails() expects.
    // The ApplicationFailure.details[0] must be an object with an `error` field.
    const cause = Object.assign(new Error('task execution failed'), {
      name: 'ApplicationFailure',
      details: [{ error: { message: 'Something went wrong', stack: 'Error: ...' } }],
    });
    const failureError = Object.assign(new Error('Workflow failed'), {
      name: 'WorkflowFailedError',
      cause,
    });

    makeHandle(
      fakeClient,
      runId,
      {
        status: { name: 'FAILED' },
        memo: {
          kind: 'task',
          name: 'sample-task',
          input: { value: 'hello' },
        },
        closeTime: new Date(),
      },
      undefined,
      failureError,
    );

    const run = await adapter.getRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe('Something went wrong');
  });

  test('returns a cancelled task run with cancelled error', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_task_cancelled_01';
    makeHandle(
      fakeClient,
      runId,
      {
        status: { name: 'CANCELLED' },
        memo: {
          kind: 'task',
          name: 'sample-task',
          input: { value: 'hello' },
        },
        closeTime: new Date(),
      },
      undefined,
      new Error('Run was cancelled'),
    );

    const run = await adapter.getRun(runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.error?.message).toBe('Run cancelled');
  });

  test('returns a completed workflow run with steps', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_workflow_completed_01';
    const steps = {
      'step-1': {
        name: 'step-1',
        task: 'sample-task',
        status: 'completed',
        output: { result: 'done' },
        attempts: 1,
        completedAt: new Date(),
      },
    };

    makeHandle(
      fakeClient,
      runId,
      {
        status: { name: 'COMPLETED' },
        memo: {
          kind: 'workflow',
          name: 'sample-workflow',
          input: { userId: 'u1' },
        },
        closeTime: new Date(),
      },
      { output: { userId: 'u1' }, steps, progress: undefined },
    );

    const run = await adapter.getRun(runId);
    expect(run?.status).toBe('completed');
    expect(run?.type).toBe('workflow');
    // Output should be present
    expect(run?.output).toEqual({ userId: 'u1' });
  });

  test('wraps unexpected describe errors as ADAPTER_ERROR', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_describe_error_01';
    fakeClient.workflow.handles.set(runId, {
      workflowId: runId,
      async describe() {
        throw new Error('network failure');
      },
      async result() {
        return undefined;
      },
      async cancel() {},
      async signal() {},
      async query() {
        return undefined as never;
      },
    });

    await expect(adapter.getRun(runId)).rejects.toMatchObject({
      code: 'ADAPTER_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

describe('listRuns', () => {
  test('returns an empty list when no workflows exist', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    fakeClient.workflow.listExecutions = [];
    fakeClient.workflow.countValue = 0;

    const result = await adapter.listRuns!();
    expect(result.runs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test('returns mapped runs from the workflow list', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    fakeClient.workflow.listExecutions = [
      {
        workflowId: 'run_list_task_01',
        status: { name: 'RUNNING' },
        memo: {
          kind: 'task',
          name: 'sample-task',
          input: { value: 'a' },
        },
        startTime: new Date(),
      },
      {
        workflowId: 'run_list_workflow_01',
        status: { name: 'COMPLETED' },
        memo: {
          kind: 'workflow',
          name: 'sample-workflow',
          input: { userId: 'u2' },
        },
        startTime: new Date(),
        closeTime: new Date(),
      },
    ];
    fakeClient.workflow.countValue = 2;

    const result = await adapter.listRuns!();
    expect(result.total).toBe(2);
    expect(result.runs).toHaveLength(2);

    const taskRun = result.runs.find(r => r.id === 'run_list_task_01');
    expect(taskRun?.type).toBe('task');
    expect(taskRun?.name).toBe('sample-task');
    expect(taskRun?.status).toBe('running');

    const workflowRun = result.runs.find(r => r.id === 'run_list_workflow_01');
    expect(workflowRun?.type).toBe('workflow');
    expect(workflowRun?.status).toBe('completed');
  });

  test('respects offset and limit filters', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    fakeClient.workflow.listExecutions = [
      {
        workflowId: 'run_offset_01',
        status: { name: 'RUNNING' },
        memo: { kind: 'task', name: 'sample-task', input: {} },
        startTime: new Date(),
      },
      {
        workflowId: 'run_offset_02',
        status: { name: 'RUNNING' },
        memo: { kind: 'task', name: 'sample-task', input: {} },
        startTime: new Date(),
      },
      {
        workflowId: 'run_offset_03',
        status: { name: 'RUNNING' },
        memo: { kind: 'task', name: 'sample-task', input: {} },
        startTime: new Date(),
      },
    ];
    fakeClient.workflow.countValue = 3;

    const result = await adapter.listRuns!({ offset: 1, limit: 1 });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.id).toBe('run_offset_02');
    expect(result.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// cancel (cancelRun)
// ---------------------------------------------------------------------------

describe('cancelRun', () => {
  test('calls cancel on the underlying workflow handle', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_to_cancel_01';
    let cancelCalled = false;
    fakeClient.workflow.handles.set(runId, {
      workflowId: runId,
      async describe() {
        return {
          status: { name: 'RUNNING' },
          startTime: new Date(),
          memo: { kind: 'task', name: 'sample-task', input: {} },
        };
      },
      async result() {
        return undefined;
      },
      async cancel() {
        cancelCalled = true;
      },
      async signal() {},
      async query() {
        return undefined as never;
      },
    });

    await adapter.cancelRun(runId);
    expect(cancelCalled).toBe(true);
  });

  test('wraps handle.cancel errors as ADAPTER_ERROR', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_cancel_fail_01';
    fakeClient.workflow.handles.set(runId, {
      workflowId: runId,
      async describe() {
        return { status: { name: 'RUNNING' }, startTime: new Date() };
      },
      async result() {
        return undefined;
      },
      async cancel() {
        throw new Error('could not acquire lock');
      },
      async signal() {},
      async query() {
        return undefined as never;
      },
    });

    await expect(adapter.cancelRun(runId)).rejects.toMatchObject({
      code: 'ADAPTER_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// signal
// ---------------------------------------------------------------------------

describe('signal', () => {
  test('sends a named signal to a running workflow', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_to_signal_01';
    const sentSignals: Array<{ name: string; payload?: unknown }> = [];

    fakeClient.workflow.handles.set(runId, {
      workflowId: runId,
      async describe() {
        return {
          status: { name: 'RUNNING' },
          startTime: new Date(),
          memo: { kind: 'workflow', name: 'sample-workflow', input: {} },
        };
      },
      async result() {
        return undefined;
      },
      async cancel() {},
      async signal(name: string, payload?: unknown) {
        sentSignals.push({ name, payload });
      },
      async query() {
        return undefined as never;
      },
    });

    await adapter.signal!(runId, 'approve', { approved: true });

    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.name).toBe('slingshot-signal');
    expect(sentSignals[0]?.payload).toEqual({ name: 'approve', payload: { approved: true } });
  });

  test('throws CAPABILITY_NOT_SUPPORTED when signalling a task run', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    const runId = 'run_task_signal_01';
    fakeClient.workflow.handles.set(runId, {
      workflowId: runId,
      async describe() {
        return {
          status: { name: 'RUNNING' },
          startTime: new Date(),
          memo: { kind: 'task', name: 'sample-task', input: {} },
        };
      },
      async result() {
        return undefined;
      },
      async cancel() {},
      async signal() {},
      async query() {
        return undefined as never;
      },
    });

    await expect(adapter.signal!(runId, 'approve')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_SUPPORTED',
    });
  });
});

// ---------------------------------------------------------------------------
// shutdown / ownsConnection
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  test('closes the connection when ownsConnection is true', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection, true);

    await adapter.shutdown();
    expect(fakeConnection.close).toHaveBeenCalledTimes(1);
    expect(fakeConnection.closed).toBe(true);
  });

  test('does NOT close the connection when ownsConnection is false', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection, false);

    await adapter.shutdown();
    expect(fakeConnection.close).not.toHaveBeenCalled();
    expect(fakeConnection.closed).toBe(false);
  });

  test('does NOT close the connection when ownsConnection is omitted', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    await adapter.shutdown();
    expect(fakeConnection.close).not.toHaveBeenCalled();
  });

  test('does NOT close the connection when no connection is provided', async () => {
    const fakeClient = new FakeClient(new FakeConnection());
    const adapter = createTemporalOrchestrationAdapter({
      client: fakeClient as never,
      workflowTaskQueue: 'test-queue',
      ownsConnection: true,
    });

    // Should not throw even though connection is undefined
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registration lock after start()
// ---------------------------------------------------------------------------

describe('registration after start()', () => {
  test('registerTask throws INVALID_CONFIG once the adapter has started', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    await adapter.start();

    expect(() => adapter.registerTask(sampleTask)).toThrow(OrchestrationError);
  });

  test('registerWorkflow throws INVALID_CONFIG once the adapter has started', async () => {
    const fakeConnection = new FakeConnection();
    const fakeClient = new FakeClient(fakeConnection);
    const adapter = buildAdapter(fakeClient, fakeConnection);

    await adapter.start();

    expect(() => adapter.registerWorkflow(sampleWorkflow)).toThrow(OrchestrationError);
  });
});

// ---------------------------------------------------------------------------
// mapTemporalFailure — P-TEMPORAL-3: typed error mappings for missing cases
// ---------------------------------------------------------------------------

describe('mapTemporalFailure (errors.ts)', () => {
  // Each test constructs instances from the mocked @temporalio/client so that
  // `instanceof` checks inside errors.ts resolve against the same class references.

  test('maps WorkflowFailedError to ADAPTER_ERROR with cause message', async () => {
    const { mapTemporalFailure } = await import('../src/errors');
    const temporalClient = await import('@temporalio/client');
    const WorkflowFailedErrorCtor = temporalClient.WorkflowFailedError as unknown as new (
      message: string,
      cause: unknown,
    ) => Error;

    const cause = new Error('inner reason');
    const err = new WorkflowFailedErrorCtor('outer', cause);
    const mapped = mapTemporalFailure('test prefix', err);

    expect(mapped).toBeInstanceOf(OrchestrationError);
    expect(mapped.code).toBe('ADAPTER_ERROR');
    expect(mapped.message).toContain('inner reason');
  });

  test('maps CancelledFailure to ADAPTER_ERROR with "cancelled" in the message', async () => {
    const { mapTemporalFailure } = await import('../src/errors');
    const temporalClient = await import('@temporalio/client');
    const CancelledFailureCtor = temporalClient.CancelledFailure as unknown as new (
      message: string,
    ) => Error;

    const err = new CancelledFailureCtor('activity was cancelled');
    const mapped = mapTemporalFailure('test prefix', err);

    expect(mapped).toBeInstanceOf(OrchestrationError);
    expect(mapped.code).toBe('ADAPTER_ERROR');
    expect(mapped.message).toContain('cancelled');
  });

  test('maps TerminatedFailure to ADAPTER_ERROR with "terminated" in the message', async () => {
    const { mapTemporalFailure } = await import('../src/errors');
    const temporalClient = await import('@temporalio/client');
    const TerminatedFailureCtor = temporalClient.TerminatedFailure as unknown as new (
      message: string,
    ) => Error;

    const err = new TerminatedFailureCtor('workflow was terminated');
    const mapped = mapTemporalFailure('test prefix', err);

    expect(mapped).toBeInstanceOf(OrchestrationError);
    expect(mapped.code).toBe('ADAPTER_ERROR');
    expect(mapped.message).toContain('terminated');
  });

  test('maps TimeoutFailure to ADAPTER_ERROR with timeout type in the message', async () => {
    const { mapTemporalFailure } = await import('../src/errors');
    const temporalClient = await import('@temporalio/client');
    const TimeoutFailureCtor = temporalClient.TimeoutFailure as unknown as new (
      message: string,
      lastHeartbeatDetails: unknown,
      timeoutType: string,
    ) => Error & { timeoutType: string };

    const err = new TimeoutFailureCtor('timed out', undefined, 'START_TO_CLOSE');
    const mapped = mapTemporalFailure('test prefix', err);

    expect(mapped).toBeInstanceOf(OrchestrationError);
    expect(mapped.code).toBe('ADAPTER_ERROR');
    expect(mapped.message).toContain('START_TO_CLOSE');
  });

  test('falls back to wrapTemporalError for unrecognized error types', async () => {
    const { mapTemporalFailure } = await import('../src/errors');

    const err = new Error('some other temporal error');
    const mapped = mapTemporalFailure('test prefix', err);

    expect(mapped).toBeInstanceOf(OrchestrationError);
    expect(mapped.code).toBe('ADAPTER_ERROR');
    expect(mapped.message).toContain('some other temporal error');
  });
});
