import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Shared Redis mock used across all describe blocks in this file.
// The adapter obtains its Redis client via `defaultTaskQueue.client`, which
// this mock wires to the same MockRedisClient instance.
// ---------------------------------------------------------------------------

class MockRedisClient {
  private values = new Map<string, string>();
  private sortedSets = new Map<string, Map<string, number>>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }

  async mget(...keys: string[]) {
    return keys.map(key => this.values.get(key) ?? null);
  }

  async zadd(key: string, score: number | string, member: string) {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, Number(score));
    this.sortedSets.set(key, set);
  }

  async zrange(key: string, start: number, end: number) {
    const set = this.sortedSets.get(key);
    if (!set) return [];
    const members = [...set.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
    const normalizedEnd = end < 0 ? members.length + end : end;
    return members.slice(start, normalizedEnd + 1);
  }

  async zrem(key: string, ...members: string[]) {
    const set = this.sortedSets.get(key);
    if (!set) return;
    for (const member of members) set.delete(member);
  }

  async del(...keys: string[]) {
    for (const key of keys) {
      this.values.delete(key);
      this.sortedSets.delete(key);
    }
  }

  reset() {
    this.values.clear();
    this.sortedSets.clear();
  }
}

const mockRedis = new MockRedisClient();

class MockJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  returnvalue: unknown;
  timestamp: number;
  finishedOn?: number;
  processedOn?: number;
  failedReason = '';
  state = 'waiting';

  constructor(options: {
    id: string;
    name: string;
    data: Record<string, unknown>;
    opts?: Record<string, unknown>;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.data = options.data;
    this.opts = options.opts ?? {};
    this.timestamp = Date.now();
  }

  async waitUntilFinished(_queueEvents: unknown) {
    return this.returnvalue ?? this.data['input'];
  }

  async getState() {
    return this.state;
  }

  async remove() {}
  async moveToFailed() {
    this.state = 'failed';
    this.failedReason = 'Run cancelled';
    this.finishedOn = Date.now();
  }
}

class MockQueue {
  static instances: MockQueue[] = [];

  name: string;
  jobs: MockJob[] = [];

  constructor(name: string) {
    this.name = name;
    MockQueue.instances.push(this);
  }

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    const id = String(
      (opts?.['jobId'] as string | undefined) ??
        data['runId'] ??
        `${this.name}-${this.jobs.length + 1}`,
    );
    const job = new MockJob({ id, name, data, opts });
    this.jobs.push(job);
    return job;
  }

  async getJobs() {
    return this.jobs;
  }

  async getJobSchedulers() {
    return [];
  }

  async removeJobScheduler() {}

  get client() {
    return Promise.resolve(mockRedis);
  }

  async close() {}
}

class MockQueueEvents {
  static instances: MockQueueEvents[] = [];

  name: string;

  constructor(name: string) {
    this.name = name;
    MockQueueEvents.instances.push(this);
  }

  on() {}
  off() {}
  async close() {}
}

class MockWorker {
  static instances: MockWorker[] = [];

  constructor(
    public name: string,
    public processor: (job: Record<string, unknown>) => Promise<unknown>,
    public opts: Record<string, unknown>,
  ) {
    MockWorker.instances.push(this);
  }

  on(_event: string, _listener: (...args: unknown[]) => void) {}

  async close() {}
}

mock.module('bullmq', () => ({
  Job: {
    fromId: async (queue: MockQueue, jobId: string) =>
      queue.jobs.find(job => job.id === jobId) ?? null,
  },
  Queue: MockQueue,
  QueueEvents: MockQueueEvents,
  Worker: MockWorker,
}));

let createBullMQOrchestrationAdapter: (typeof import('../src/adapter'))['createBullMQOrchestrationAdapter'];

beforeAll(async () => {
  const mod = await import('../src/adapter');
  createBullMQOrchestrationAdapter = mod.createBullMQOrchestrationAdapter;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(prefix: string) {
  return createBullMQOrchestrationAdapter({
    connection: { host: '127.0.0.1', port: 6379 },
    prefix,
  });
}

function cancelledKey(prefix: string, runId: string) {
  return `${prefix}:cancelled:run:${runId}`;
}

function cancelledIndex(prefix: string) {
  return `${prefix}:cancelled:runs`;
}

// ---------------------------------------------------------------------------
// Serialization / deserialization roundtrip
// ---------------------------------------------------------------------------

describe('run snapshot serialization roundtrip', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
    mockRedis.reset();
  });

  test('task run snapshot roundtrips with all date fields restored as Date objects', async () => {
    const prefix = 'roundtrip-task';
    const now = new Date('2024-06-01T12:00:00.000Z');
    const started = new Date('2024-06-01T12:00:01.000Z');
    const completed = new Date('2024-06-01T12:00:02.000Z');

    const snapshot = JSON.stringify({
      id: 'run-task-1',
      type: 'task',
      name: 'my-task',
      status: 'completed',
      input: { userId: 'u1' },
      output: { ok: true },
      error: undefined,
      tenantId: 'tenant-a',
      priority: 5,
      tags: { env: 'prod' },
      metadata: { source: 'api' },
      progress: null,
      createdAt: now.toISOString(),
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
    });

    await mockRedis.set(cancelledKey(prefix, 'run-task-1'), snapshot);
    await mockRedis.zadd(cancelledIndex(prefix), now.getTime(), 'run-task-1');

    const adapter = makeAdapter(prefix);
    const run = await adapter.getRun('run-task-1');

    expect(run).not.toBeNull();
    expect(run?.id).toBe('run-task-1');
    expect(run?.type).toBe('task');
    expect(run?.name).toBe('my-task');
    expect(run?.status).toBe('completed');
    expect(run?.tenantId).toBe('tenant-a');
    expect(run?.createdAt).toEqual(now);
    expect(run?.startedAt).toEqual(started);
    expect(run?.completedAt).toEqual(completed);
    expect(run?.tags).toEqual({ env: 'prod' });

    await adapter.shutdown();
  });

  test('task run with only createdAt set roundtrips with startedAt and completedAt as undefined', async () => {
    const prefix = 'roundtrip-minimal';
    const now = new Date('2024-07-15T08:00:00.000Z');

    const snapshot = JSON.stringify({
      id: 'run-minimal',
      type: 'task',
      name: 'minimal-task',
      status: 'pending',
      input: {},
      output: null,
      createdAt: now.toISOString(),
    });

    await mockRedis.set(cancelledKey(prefix, 'run-minimal'), snapshot);
    await mockRedis.zadd(cancelledIndex(prefix), now.getTime(), 'run-minimal');

    const adapter = makeAdapter(prefix);
    const run = await adapter.getRun('run-minimal');

    expect(run).not.toBeNull();
    expect(run?.createdAt).toEqual(now);
    expect(run?.startedAt).toBeUndefined();
    expect(run?.completedAt).toBeUndefined();

    await adapter.shutdown();
  });

  test('workflow run snapshot roundtrips with step dates restored', async () => {
    const prefix = 'roundtrip-workflow';
    const now = new Date('2024-08-01T10:00:00.000Z');
    const stepStarted = new Date('2024-08-01T10:00:01.000Z');
    const stepCompleted = new Date('2024-08-01T10:00:03.000Z');

    const snapshot = JSON.stringify({
      id: 'run-workflow-1',
      type: 'workflow',
      name: 'my-workflow',
      status: 'completed',
      input: { email: 'user@example.com' },
      output: { sent: true },
      createdAt: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: stepCompleted.toISOString(),
      steps: {
        'send-email': {
          name: 'send-email',
          status: 'completed',
          output: { sent: true },
          startedAt: stepStarted.toISOString(),
          completedAt: stepCompleted.toISOString(),
        },
      },
    });

    await mockRedis.set(cancelledKey(prefix, 'run-workflow-1'), snapshot);
    await mockRedis.zadd(cancelledIndex(prefix), now.getTime(), 'run-workflow-1');

    const adapter = makeAdapter(prefix);
    const run = await adapter.getRun('run-workflow-1');

    expect(run).not.toBeNull();
    expect(run?.type).toBe('workflow');

    const workflowRun = run as {
      steps?: Record<string, { startedAt?: Date; completedAt?: Date; status: string }>;
    };
    expect(workflowRun.steps?.['send-email']?.status).toBe('completed');
    expect(workflowRun.steps?.['send-email']?.startedAt).toEqual(stepStarted);
    expect(workflowRun.steps?.['send-email']?.completedAt).toEqual(stepCompleted);

    await adapter.shutdown();
  });

  test('workflow run with no steps field roundtrips without steps property', async () => {
    const prefix = 'roundtrip-no-steps';
    const now = new Date('2024-09-01T00:00:00.000Z');

    const snapshot = JSON.stringify({
      id: 'run-no-steps',
      type: 'workflow',
      name: 'empty-workflow',
      status: 'running',
      input: {},
      output: null,
      createdAt: now.toISOString(),
    });

    await mockRedis.set(cancelledKey(prefix, 'run-no-steps'), snapshot);
    await mockRedis.zadd(cancelledIndex(prefix), now.getTime(), 'run-no-steps');

    const adapter = makeAdapter(prefix);
    const run = await adapter.getRun('run-no-steps');

    expect(run).not.toBeNull();
    expect(run?.type).toBe('workflow');
    const workflowRun = run as { steps?: unknown };
    expect(workflowRun.steps).toBeUndefined();

    await adapter.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Deserialization failure paths — returns null + logs, never throws
// ---------------------------------------------------------------------------

describe('run snapshot deserialization failure handling (P-OBULLMQ-2)', () => {
  beforeEach(() => {
    MockQueue.instances = [];
    MockQueueEvents.instances = [];
    MockWorker.instances = [];
    mockRedis.reset();
  });

  function makeAdapterWithCapture(prefix: string) {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const events: Array<{ name: string; payload: unknown }> = [];
    const make = (
      base: Record<string, unknown> | undefined,
    ): import('@lastshotlabs/slingshot-core').Logger => ({
      debug() {},
      info() {},
      warn() {},
      error(msg, fields) {
        logs.push({ msg, fields: { ...(base ?? {}), ...(fields ?? {}) } });
      },
      child(fields) {
        return make({ ...(base ?? {}), ...fields });
      },
    });
    const adapter = createBullMQOrchestrationAdapter({
      connection: { host: '127.0.0.1', port: 6379 },
      prefix,
      structuredLogger: make(undefined),
      eventSink: {
        emit(name, payload) {
          events.push({ name, payload });
        },
      },
    });
    return { adapter, logs, events };
  }

  test('invalid JSON quarantines the snapshot and emits orchestration.bullmq.snapshotMalformed', async () => {
    const prefix = 'deser-invalid-json';
    const runId = 'run-bad-json';

    await mockRedis.set(cancelledKey(prefix, runId), '{not valid json!!!');
    await mockRedis.zadd(cancelledIndex(prefix), Date.now(), runId);

    const { adapter, logs, events } = makeAdapterWithCapture(prefix);
    const run = await adapter.getRun(runId);

    expect(run).toBeNull();
    const malformedLog = logs.find(l => l.msg === 'orchestration.bullmq.snapshotMalformed');
    expect(malformedLog).toBeDefined();
    expect(malformedLog?.fields).toMatchObject({ runId });

    const malformedEvent = events.find(e => e.name === 'orchestration.bullmq.snapshotMalformed');
    expect(malformedEvent).toBeDefined();

    // The malformed copy is preserved under :malformed for forensics; the live
    // key is left intact (only listRuns sweeps the index).
    const preserved = await mockRedis.get(`${cancelledKey(prefix, runId)}:malformed`);
    expect(preserved).toBe('{not valid json!!!');

    await adapter.shutdown();
  });

  test('truncated JSON quarantines and surfaces a malformed event', async () => {
    const prefix = 'deser-truncated';
    const runId = 'run-truncated';

    await mockRedis.set(cancelledKey(prefix, runId), '{"id":"run-truncated","createdAt":"2024');
    await mockRedis.zadd(cancelledIndex(prefix), Date.now(), runId);

    const { adapter, logs } = makeAdapterWithCapture(prefix);
    const run = await adapter.getRun(runId);

    expect(run).toBeNull();
    expect(logs.some(l => l.msg === 'orchestration.bullmq.snapshotMalformed')).toBe(true);

    const preserved = await mockRedis.get(`${cancelledKey(prefix, runId)}:malformed`);
    expect(preserved).toBe('{"id":"run-truncated","createdAt":"2024');

    await adapter.shutdown();
  });

  test('null Redis payload returns null without raising malformed events', async () => {
    const prefix = 'deser-null-payload';
    const runId = 'run-null-payload';

    await mockRedis.zadd(cancelledIndex(prefix), Date.now(), runId);

    const { adapter, logs } = makeAdapterWithCapture(prefix);
    const run = await adapter.getRun(runId);

    expect(run).toBeNull();
    expect(logs.some(l => l.msg === 'orchestration.bullmq.snapshotMalformed')).toBe(false);

    await adapter.shutdown();
  });

  test('listRuns drops corrupted entries from the index but preserves :malformed copies', async () => {
    const prefix = 'deser-list-mixed';
    const goodRunId = 'run-good';
    const badRunId = 'run-bad';
    const ts = Date.now();

    const goodPayload = JSON.stringify({
      id: goodRunId,
      type: 'task',
      name: 'good-task',
      status: 'cancelled',
      input: {},
      output: null,
      createdAt: new Date(ts - 1000).toISOString(),
    });

    await mockRedis.set(cancelledKey(prefix, goodRunId), goodPayload);
    await mockRedis.zadd(cancelledIndex(prefix), ts - 1000, goodRunId);

    await mockRedis.set(cancelledKey(prefix, badRunId), '{"broken":');
    await mockRedis.zadd(cancelledIndex(prefix), ts, badRunId);

    const { adapter, logs } = makeAdapterWithCapture(prefix);
    const result = await adapter.listRuns({ status: 'cancelled' });

    expect(result.total).toBe(1);
    expect(result.runs[0]?.id).toBe(goodRunId);

    expect(logs.some(l => l.msg === 'orchestration.bullmq.snapshotMalformed')).toBe(true);
    const preserved = await mockRedis.get(`${cancelledKey(prefix, badRunId)}:malformed`);
    expect(preserved).toBe('{"broken":');

    await adapter.shutdown();
  });
});
