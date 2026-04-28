import Database from 'better-sqlite3';
import { createCachedRunHandle, generateRunId } from '../adapter';
import { createTaskRunner } from '../engine/taskRunner';
import { executeWorkflow } from '../engine/workflowRunner';
import { OrchestrationError } from '../errors';
import { createIdempotencyScope } from '../idempotency';
import { resolveMaxPayloadBytes, serializeWithLimit } from '../serialization';
import type {
  AnyResolvedTask,
  AnyResolvedWorkflow,
  ObservabilityCapability,
  OrchestrationAdapter,
  OrchestrationEventSink,
  Run,
  RunHandle,
  RunProgress,
  RunStatus,
  StepRun,
  WorkflowRun,
} from '../types';
import { sqliteAdapterOptionsSchema } from '../validation';

type SqliteRunRow = {
  id: string;
  type: 'task' | 'workflow';
  name: string;
  status: RunStatus;
  input: string;
  output: string | null;
  error: string | null;
  idempotency_key: string | null;
  tenant_id: string | null;
  priority: number;
  tags: string | null;
  metadata: string | null;
  progress: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type SqliteStepRow = {
  run_id: string;
  name: string;
  task: string;
  status: RunStatus;
  output: string | null;
  error: string | null;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

function toRun(row: SqliteRunRow, steps?: Record<string, StepRun>): Run | WorkflowRun {
  const base: Run = {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    input: JSON.parse(row.input),
    output: parseJson(row.output),
    error: parseJson(row.error),
    tenantId: row.tenant_id ?? undefined,
    priority: row.priority,
    tags: parseJson(row.tags),
    metadata: parseJson(row.metadata),
    progress: parseJson(row.progress),
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  };
  if (row.type === 'workflow') {
    return { ...base, type: 'workflow', steps };
  }
  return base;
}

function matchesTags(
  runTags: Record<string, string> | undefined,
  filterTags: Record<string, string>,
): boolean {
  if (!runTags) return false;
  return Object.entries(filterTags).every(([key, value]) => runTags[key] === value);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
      },
      { once: true },
    );
  });
}

function isSqliteUniqueConstraintError(error: unknown, columnName: string): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed') &&
    error.message.includes(columnName)
  );
}

/**
 * Create the SQLite-backed orchestration adapter.
 *
 * This adapter reuses the shared task/workflow runners from the core package while
 * persisting run and step state to SQLite so pending work can resume after restart.
 */
export function createSqliteAdapter(options: {
  path: string;
  concurrency?: number;
  eventSink?: OrchestrationEventSink;
  maxPayloadBytes?: number;
  logger?: import('@lastshotlabs/slingshot-core').Logger;
}): OrchestrationAdapter & ObservabilityCapability {
  const parsed = sqliteAdapterOptionsSchema.parse(options);
  const maxPayloadBytes = resolveMaxPayloadBytes(parsed.maxPayloadBytes, 'sqlite adapter');
  let db: Database.Database;
  try {
    db = new Database(parsed.path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    throw new OrchestrationError(
      'ADAPTER_ERROR',
      `Failed to open SQLite database at '${parsed.path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_runs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL,
      output TEXT,
      error TEXT,
      idempotency_key TEXT UNIQUE,
      tenant_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      metadata TEXT,
      progress TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orchestration_steps (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status ON orchestration_runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_name ON orchestration_runs(name);
    CREATE INDEX IF NOT EXISTS idx_runs_tenant ON orchestration_runs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_runs_priority ON orchestration_runs(status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON orchestration_runs(created_at);
  `);
  } catch (error) {
    db.close();
    throw new OrchestrationError(
      'ADAPTER_ERROR',
      `Failed to initialize SQLite schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const taskRegistry = new Map<string, AnyResolvedTask>();
  const workflowRegistry = new Map<string, AnyResolvedWorkflow>();
  const resultPromises = new Map<string, Promise<unknown>>();
  const progressListeners = new Map<string, Map<string, (data: RunProgress | undefined) => void>>();
  const workflowControllers = new Map<string, AbortController>();
  const workflowChildren = new Map<string, Set<string>>();
  const delayedWorkflowStarts = new Map<string, AbortController>();
  let started = false;
  let shuttingDown = false;
  let dbClosed = false;
  function closeDb(): void {
    if (dbClosed) return;
    dbClosed = true;
    try {
      db.close();
    } catch (err) {
      const logger = options.logger;
      if (logger) {
        logger.error('orchestration.sqlite.closeFailed', {
          error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) },
        });
      } else {
        console.error('[orchestration] sqlite db close failed', err);
      }
    }
  }

  const insertRun = db.prepare(`
    INSERT INTO orchestration_runs (
      id, type, name, status, input, output, error, idempotency_key, tenant_id, priority, tags, metadata, progress, created_at, started_at, completed_at
    ) VALUES (
      @id, @type, @name, @status, @input, @output, @error, @idempotencyKey, @tenantId, @priority, @tags, @metadata, @progress, @createdAt, @startedAt, @completedAt
    )
  `);
  const updateRunStatus = db.prepare(`
    UPDATE orchestration_runs
    SET status = @status, output = @output, error = @error, started_at = @startedAt, completed_at = @completedAt, progress = @progress
    WHERE id = @id
  `);
  const updateRunProgress = db.prepare(`
    UPDATE orchestration_runs
    SET progress = @progress
    WHERE id = @id
  `);
  const getRunRow = db.prepare(
    `SELECT * FROM orchestration_runs WHERE id = ?`,
  ) as Database.Statement<[string], SqliteRunRow>;
  const getRunByIdempotency = db.prepare(
    `SELECT id FROM orchestration_runs WHERE idempotency_key = ?`,
  ) as Database.Statement<[string], { id: string }>;
  const getRunByLegacyIdempotency = db.prepare(
    `SELECT id
     FROM orchestration_runs
     WHERE type = ?
       AND name = ?
       AND COALESCE(tenant_id, '') = COALESCE(?, '')
       AND idempotency_key = ?
     ORDER BY created_at ASC
     LIMIT 1`,
  ) as Database.Statement<['task' | 'workflow', string, string | null, string], { id: string }>;
  const upsertStep = db.prepare(`
    INSERT INTO orchestration_steps (run_id, name, task, status, output, error, attempts, started_at, completed_at)
    VALUES (@runId, @name, @task, @status, @output, @error, @attempts, @startedAt, @completedAt)
    ON CONFLICT(run_id, name) DO UPDATE SET
      task = excluded.task,
      status = excluded.status,
      output = excluded.output,
      error = excluded.error,
      attempts = excluded.attempts,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at
  `);
  const stepRowsByRun = db.prepare(
    `SELECT * FROM orchestration_steps WHERE run_id = ? ORDER BY name ASC`,
  ) as Database.Statement<[string], SqliteStepRow>;
  const getStepStartedAt = db.prepare(
    `SELECT started_at FROM orchestration_steps WHERE run_id = ? AND name = ?`,
  ) as Database.Statement<[string, string], { started_at: string | null }>;
  const recoverRows = db.prepare(
    `SELECT * FROM orchestration_runs
      WHERE status IN ('pending', 'running')
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT ?`,
  ) as Database.Statement<[number], SqliteRunRow>;
  const recoverRowsAfter = db.prepare(
    `SELECT * FROM orchestration_runs
      WHERE status IN ('pending', 'running')
        AND (
          priority < ?
          OR (priority = ? AND created_at > ?)
          OR (priority = ? AND created_at = ? AND id > ?)
        )
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT ?`,
  ) as Database.Statement<[number, number, string, number, string, string, number], SqliteRunRow>;

  function notifyProgress(runId: string, progress: RunProgress | undefined): void {
    for (const listener of progressListeners.get(runId)?.values() ?? []) {
      listener(progress);
    }
  }

  function pollForResult(runId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let delay = 50;
      const maxDelay = 2_000;
      function poll() {
        const row = getRunRow.get(runId);
        if (!row) {
          reject(new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`));
          return;
        }
        if (row.status === 'completed') {
          resolve(parseJson(row.output));
          return;
        }
        if (row.status === 'failed' || row.status === 'cancelled') {
          reject(new Error(parseJson<{ message: string }>(row.error)?.message ?? 'Run failed'));
          return;
        }
        delay = Math.min(delay * 2, maxDelay);
        setTimeout(poll, delay);
      }
      setTimeout(poll, delay);
    });
  }

  const taskRunner = createTaskRunner({
    concurrency: parsed.concurrency ?? 10,
    eventSink: options.eventSink,
    logger: options.logger,
    callbacks: {
      onStarted(runId) {
        updateRunStatus.run({
          id: runId,
          status: 'running',
          output: null,
          error: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
          progress: null,
        });
      },
      onProgress(runId, _taskName, data) {
        updateRunProgress.run({ id: runId, progress: json(data) });
        notifyProgress(runId, data);
      },
      onCompleted(runId, taskName, output) {
        let serializedOutput: string;
        try {
          serializedOutput = serializeWithLimit(
            output,
            maxPayloadBytes,
            `task '${taskName}' output`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : `task '${taskName}' output rejected`;
          updateRunStatus.run({
            id: runId,
            status: 'failed',
            output: null,
            error: json({ message }),
            startedAt: getRunRow.get(runId)?.started_at ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: getRunRow.get(runId)?.progress ?? null,
          });
          return;
        }
        updateRunStatus.run({
          id: runId,
          status: 'completed',
          output: serializedOutput,
          error: null,
          startedAt: getRunRow.get(runId)?.started_at ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          progress: getRunRow.get(runId)?.progress ?? null,
        });
      },
      onFailed(runId, _taskName, error, _durationMs, status) {
        updateRunStatus.run({
          id: runId,
          status,
          output: null,
          error: json(error),
          startedAt: getRunRow.get(runId)?.started_at ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          progress: getRunRow.get(runId)?.progress ?? null,
        });
      },
    },
  });

  function createHandle(runId: string, promise?: Promise<unknown>): RunHandle {
    const loader = promise ?? resultPromises.get(runId) ?? pollForResult(runId);
    resultPromises.set(runId, loader);
    return createCachedRunHandle(runId, () => loader);
  }

  function findExistingIdempotentRun(
    target: { type: 'task' | 'workflow'; name: string },
    opts: { tenantId?: string; idempotencyKey?: string },
  ): { id: string } | undefined {
    const scopedIdempotencyKey = createIdempotencyScope(target, opts);
    if (!scopedIdempotencyKey) {
      return undefined;
    }

    return (
      getRunByIdempotency.get(scopedIdempotencyKey) ??
      (opts.idempotencyKey
        ? getRunByLegacyIdempotency.get(
            target.type,
            target.name,
            opts.tenantId ?? null,
            opts.idempotencyKey,
          )
        : undefined)
    );
  }

  async function recoverRun(row: SqliteRunRow): Promise<void> {
    if (row.type === 'task') {
      const def = taskRegistry.get(row.name);
      if (!def) return;
      const promise = taskRunner
        .submit(def, JSON.parse(row.input), {
          runId: row.id,
          tenantId: row.tenant_id ?? undefined,
          priority: row.priority,
        })
        .result();
      resultPromises.set(row.id, promise);
      return;
    }

    const def = workflowRegistry.get(row.name);
    if (!def) return;
    const controller = new AbortController();
    workflowControllers.set(row.id, controller);
    workflowChildren.set(row.id, new Set());
    const steps = Object.fromEntries(
      stepRowsByRun.all(row.id).map(step => [
        step.name,
        {
          name: step.name,
          task: step.task,
          status: step.status,
          output: parseJson(step.output),
          error: parseJson(step.error),
          attempts: step.attempts,
          startedAt: step.started_at ? new Date(step.started_at) : undefined,
          completedAt: step.completed_at ? new Date(step.completed_at) : undefined,
        } satisfies StepRun,
      ]),
    );
    const results = Object.fromEntries(
      Object.entries(steps)
        .filter(([, step]) => step.status === 'completed' || step.status === 'skipped')
        .map(([name, step]) => [name, step.output]),
    );
    const promise = executeWorkflow({
      def,
      input: JSON.parse(row.input),
      runId: row.id,
      tenantId: row.tenant_id ?? undefined,
      signal: controller.signal,
      taskRunner,
      taskRegistry,
      eventSink: options.eventSink,
      persistedState: { results, steps },
      onChildRun(childRunId) {
        workflowChildren.get(row.id)?.add(childRunId);
      },
      callbacks: {
        onStarted(runId) {
          updateRunStatus.run({
            id: runId,
            status: 'running',
            output: null,
            error: null,
            startedAt: new Date().toISOString(),
            completedAt: null,
            progress: getRunRow.get(runId)?.progress ?? null,
          });
        },
        onStepStarted(runId, stepName, taskName) {
          // Preserve existing attempt count from persisted state so retries are
          // counted correctly after crash recovery.
          const existingRow = stepRowsByRun.all(runId).find(s => s.name === stepName);
          const previousAttempts = existingRow?.attempts ?? 0;
          upsertStep.run({
            runId,
            name: stepName,
            task: taskName,
            status: 'running',
            output: null,
            error: null,
            attempts: previousAttempts + 1,
            startedAt: existingRow?.started_at ?? new Date().toISOString(),
            completedAt: null,
          });
        },
        onStepCompleted(runId, stepName, taskName, output, attempts) {
          upsertStep.run({
            runId,
            name: stepName,
            task: taskName,
            status: 'completed',
            output: json(output),
            error: null,
            attempts,
            startedAt:
              getStepStartedAt.get(runId, stepName)?.started_at ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        },
        onStepFailed(runId, stepName, taskName, error, attempts, status = 'failed') {
          upsertStep.run({
            runId,
            name: stepName,
            task: taskName,
            status,
            output: null,
            error: json(error),
            attempts,
            startedAt:
              getStepStartedAt.get(runId, stepName)?.started_at ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        },
        onStepSkipped(runId, stepName, taskName) {
          upsertStep.run({
            runId,
            name: stepName,
            task: taskName,
            status: 'skipped',
            output: null,
            error: null,
            attempts: 0,
            startedAt: null,
            completedAt: new Date().toISOString(),
          });
        },
        onSleepStarted(runId, stepName, wakeAt) {
          upsertStep.run({
            runId,
            name: stepName,
            task: '__sleep__',
            status: 'running',
            output: json({ wakeAt }),
            error: null,
            attempts: 1,
            startedAt: new Date().toISOString(),
            completedAt: null,
          });
        },
        onCompleted(runId, output) {
          updateRunStatus.run({
            id: runId,
            status: 'completed',
            output: json(output),
            error: null,
            startedAt: getRunRow.get(runId)?.started_at ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: getRunRow.get(runId)?.progress ?? null,
          });
        },
        onFailed(runId, error, _failedStep, _durationMs, status = 'failed') {
          updateRunStatus.run({
            id: runId,
            status,
            output: null,
            error: json(error),
            startedAt: getRunRow.get(runId)?.started_at ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: getRunRow.get(runId)?.progress ?? null,
          });
        },
      },
    }).finally(() => {
      workflowControllers.delete(row.id);
      workflowChildren.delete(row.id);
    });
    resultPromises.set(row.id, promise);
  }

  async function startAdapter(): Promise<void> {
    if (started) return;
    started = true;
    const batchSize = 100;
    let batch = recoverRows.all(batchSize);
    while (batch.length > 0) {
      for (const row of batch) {
        await recoverRun(row);
      }
      const last = batch[batch.length - 1];
      batch = recoverRowsAfter.all(
        last.priority,
        last.priority,
        last.created_at,
        last.priority,
        last.created_at,
        last.id,
        batchSize,
      );
    }
  }

  async function ensureStarted(): Promise<void> {
    if (!started) {
      await startAdapter();
    }
  }

  return {
    registerTask(def) {
      taskRegistry.set(def.name, def);
    },
    registerWorkflow(def) {
      workflowRegistry.set(def.name, def);
    },
    async runTask(name, input, opts) {
      await ensureStarted();
      if (shuttingDown) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Adapter is shutting down.');
      }
      const def = taskRegistry.get(name);
      if (!def) {
        throw new OrchestrationError('TASK_NOT_FOUND', `Task '${name}' not registered`);
      }
      const scopedIdempotencyKey = createIdempotencyScope({ type: 'task', name }, opts ?? {});
      if (scopedIdempotencyKey) {
        const existing = findExistingIdempotentRun({ type: 'task', name }, opts ?? {});
        if (existing) return createHandle(existing.id);
      }
      const runId = generateRunId();
      const serializedInput = serializeWithLimit(input, maxPayloadBytes, `task '${name}' input`);
      try {
        insertRun.run({
          id: runId,
          type: 'task',
          name,
          status: 'pending',
          input: serializedInput,
          output: null,
          error: null,
          idempotencyKey: scopedIdempotencyKey ?? null,
          tenantId: opts?.tenantId ?? null,
          priority: opts?.priority ?? 0,
          tags: opts?.tags ? json(opts.tags) : null,
          metadata: opts?.metadata ? json(opts.metadata) : null,
          progress: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        });
      } catch (error) {
        if (scopedIdempotencyKey && isSqliteUniqueConstraintError(error, 'idempotency_key')) {
          const existing = getRunByIdempotency.get(scopedIdempotencyKey);
          if (existing) {
            return createHandle(existing.id);
          }
        }
        throw error;
      }
      const promise = taskRunner
        .submit(def, input, {
          runId,
          tenantId: opts?.tenantId,
          priority: opts?.priority,
          delay: opts?.delay,
        })
        .result();
      resultPromises.set(runId, promise);
      return createHandle(runId, promise);
    },
    async runWorkflow(name, input, opts) {
      await ensureStarted();
      if (shuttingDown) {
        throw new OrchestrationError('ADAPTER_ERROR', 'Adapter is shutting down.');
      }
      const def = workflowRegistry.get(name);
      if (!def) {
        throw new OrchestrationError('WORKFLOW_NOT_FOUND', `Workflow '${name}' not registered`);
      }
      const scopedIdempotencyKey = createIdempotencyScope({ type: 'workflow', name }, opts ?? {});
      if (scopedIdempotencyKey) {
        const existing = findExistingIdempotentRun({ type: 'workflow', name }, opts ?? {});
        if (existing) return createHandle(existing.id);
      }
      const runId = generateRunId();
      const serializedInput = serializeWithLimit(
        input,
        maxPayloadBytes,
        `workflow '${name}' input`,
      );
      try {
        insertRun.run({
          id: runId,
          type: 'workflow',
          name,
          status: 'pending',
          input: serializedInput,
          output: null,
          error: null,
          idempotencyKey: scopedIdempotencyKey ?? null,
          tenantId: opts?.tenantId ?? null,
          priority: opts?.priority ?? 0,
          tags: opts?.tags ? json(opts.tags) : null,
          metadata: opts?.metadata ? json(opts.metadata) : null,
          progress: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        });
      } catch (error) {
        if (scopedIdempotencyKey && isSqliteUniqueConstraintError(error, 'idempotency_key')) {
          const existing = getRunByIdempotency.get(scopedIdempotencyKey);
          if (existing) {
            return createHandle(existing.id);
          }
        }
        throw error;
      }
      const controller = new AbortController();
      workflowControllers.set(runId, controller);
      workflowChildren.set(runId, new Set());
      const delayController = new AbortController();
      delayedWorkflowStarts.set(runId, delayController);
      const promise = (async () => {
        try {
          if ((opts?.delay ?? 0) > 0) {
            await wait(opts?.delay ?? 0, delayController.signal);
          }

          delayedWorkflowStarts.delete(runId);
          return await executeWorkflow({
            def,
            input,
            runId,
            tenantId: opts?.tenantId,
            signal: controller.signal,
            taskRunner,
            taskRegistry,
            eventSink: options.eventSink,
            onChildRun(childRunId) {
              workflowChildren.get(runId)?.add(childRunId);
            },
            callbacks: {
              onStarted(runIdValue) {
                updateRunStatus.run({
                  id: runIdValue,
                  status: 'running',
                  output: null,
                  error: null,
                  startedAt: new Date().toISOString(),
                  completedAt: null,
                  progress: getRunRow.get(runIdValue)?.progress ?? null,
                });
              },
              onStepStarted(runIdValue, stepName, taskName) {
                upsertStep.run({
                  runId: runIdValue,
                  name: stepName,
                  task: taskName,
                  status: 'running',
                  output: null,
                  error: null,
                  attempts: 1,
                  startedAt: new Date().toISOString(),
                  completedAt: null,
                });
              },
              onStepCompleted(runIdValue, stepName, taskName, output, attempts) {
                upsertStep.run({
                  runId: runIdValue,
                  name: stepName,
                  task: taskName,
                  status: 'completed',
                  output: json(output),
                  error: null,
                  attempts,
                  startedAt:
                    stepRowsByRun.all(runIdValue).find(step => step.name === stepName)
                      ?.started_at ?? new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                });
              },
              onStepFailed(runIdValue, stepName, taskName, error, attempts, status = 'failed') {
                upsertStep.run({
                  runId: runIdValue,
                  name: stepName,
                  task: taskName,
                  status,
                  output: null,
                  error: json(error),
                  attempts,
                  startedAt:
                    stepRowsByRun.all(runIdValue).find(step => step.name === stepName)
                      ?.started_at ?? new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                });
              },
              onStepSkipped(runIdValue, stepName, taskName) {
                upsertStep.run({
                  runId: runIdValue,
                  name: stepName,
                  task: taskName,
                  status: 'skipped',
                  output: null,
                  error: null,
                  attempts: 0,
                  startedAt: null,
                  completedAt: new Date().toISOString(),
                });
              },
              onSleepStarted(runIdValue, stepName, wakeAt) {
                upsertStep.run({
                  runId: runIdValue,
                  name: stepName,
                  task: '__sleep__',
                  status: 'running',
                  output: json({ wakeAt }),
                  error: null,
                  attempts: 1,
                  startedAt: new Date().toISOString(),
                  completedAt: null,
                });
              },
              onCompleted(runIdValue, output) {
                updateRunStatus.run({
                  id: runIdValue,
                  status: 'completed',
                  output: json(output),
                  error: null,
                  startedAt: getRunRow.get(runIdValue)?.started_at ?? new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  progress: getRunRow.get(runIdValue)?.progress ?? null,
                });
              },
              onFailed(runIdValue, error, _failedStep, _durationMs, status = 'failed') {
                updateRunStatus.run({
                  id: runIdValue,
                  status,
                  output: null,
                  error: json(error),
                  startedAt: getRunRow.get(runIdValue)?.started_at ?? new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  progress: getRunRow.get(runIdValue)?.progress ?? null,
                });
              },
            },
          });
        } finally {
          delayedWorkflowStarts.delete(runId);
          workflowControllers.delete(runId);
          workflowChildren.delete(runId);
        }
      })();
      resultPromises.set(runId, promise);
      return createHandle(runId, promise);
    },
    async getRun(runId) {
      const row = getRunRow.get(runId);
      if (!row) return null;
      const steps =
        row.type === 'workflow'
          ? Object.fromEntries(
              stepRowsByRun.all(runId).map(step => [
                step.name,
                {
                  name: step.name,
                  task: step.task,
                  status: step.status,
                  output: parseJson(step.output),
                  error: parseJson(step.error),
                  attempts: step.attempts,
                  startedAt: step.started_at ? new Date(step.started_at) : undefined,
                  completedAt: step.completed_at ? new Date(step.completed_at) : undefined,
                } satisfies StepRun,
              ]),
            )
          : undefined;
      return toRun(row, steps);
    },
    async cancelRun(runId) {
      const row = getRunRow.get(runId);
      if (!row) {
        throw new OrchestrationError('RUN_NOT_FOUND', `Run '${runId}' not found`);
      }
      if (row.type === 'task') {
        await taskRunner.cancel(runId);
      } else {
        delayedWorkflowStarts.get(runId)?.abort(new Error('Run cancelled'));
        workflowControllers.get(runId)?.abort(new Error('Run cancelled'));
        for (const childRunId of workflowChildren.get(runId) ?? []) {
          await taskRunner.cancel(childRunId);
        }
      }
      updateRunStatus.run({
        id: runId,
        status: 'cancelled',
        output: null,
        error: json({ message: 'Run cancelled' }),
        startedAt: row.started_at ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        progress: row.progress,
      });
    },
    async start() {
      await startAdapter();
    },
    async shutdown() {
      shuttingDown = true;
      try {
        for (const controller of delayedWorkflowStarts.values()) {
          controller.abort(new Error('Run cancelled'));
        }
        for (const controller of workflowControllers.values()) {
          controller.abort(new Error('Run cancelled'));
        }
        const SHUTDOWN_TIMEOUT_MS = 30_000;
        const timeoutPromise = new Promise<void>(resolve => {
          setTimeout(() => {
            console.warn(
              '[orchestration] shutdown timed out after 30s — some tasks may still be running',
            );
            resolve();
          }, SHUTDOWN_TIMEOUT_MS);
        });
        await Promise.race([taskRunner.waitForIdle(), timeoutPromise]);
      } finally {
        closeDb();
      }
    },
    async listRuns(filter) {
      const rows = db
        .prepare(`SELECT * FROM orchestration_runs ORDER BY created_at DESC`)
        .all() as SqliteRunRow[];
      const filtered = rows
        .map(row => toRun(row))
        .filter(run => {
          if (filter?.type && run.type !== filter.type) return false;
          if (filter?.name && run.name !== filter.name) return false;
          if (filter?.tenantId && run.tenantId !== filter.tenantId) return false;
          if (filter?.status) {
            const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
            if (!statuses.includes(run.status)) return false;
          }
          if (filter?.tags && !matchesTags(run.tags, filter.tags)) return false;
          if (filter?.createdAfter && run.createdAt < filter.createdAfter) return false;
          if (filter?.createdBefore && run.createdAt > filter.createdBefore) return false;
          return true;
        });
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      return {
        runs: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    },
    onProgress(runId, callback) {
      const subscriptionId = crypto.randomUUID();
      const listeners =
        progressListeners.get(runId) ?? new Map<string, (data: RunProgress | undefined) => void>();
      listeners.set(subscriptionId, callback);
      progressListeners.set(runId, listeners);
      return () => {
        listeners.delete(subscriptionId);
        if (listeners.size === 0) {
          progressListeners.delete(runId);
        }
      };
    },
  };
}
