/**
 * In-memory fake for BullMQ's Queue and Worker classes.
 *
 * Simulates the subset of the BullMQ API that createBullMQAdapter() uses:
 * Queue.add(), Queue.close(), Worker construction, Worker.on(), Worker.close().
 * The worker processor is invoked synchronously via FakeBullMQState.dispatchJob().
 */

export interface FakeJob {
  queueName: string;
  event: string;
  data: unknown;
}

export interface FakeWorkerRecord {
  queueName: string;
  processor: (job: { data: unknown }) => Promise<void>;
  errorHandlers: Array<(err: unknown) => void>;
  failedHandlers: Array<(job: unknown, err: unknown) => void>;
  completedHandlers: Array<(job: unknown) => void>;
  closed: boolean;
}

export interface FakeQueueRecord {
  name: string;
  addCalls: FakeJob[];
  addErrors: unknown[];
  closed: boolean;
}

export interface FakeBullMQState {
  queues: FakeQueueRecord[];
  workers: FakeWorkerRecord[];
  _nextAddErrors: unknown[];
  _nextAddDelays?: number[];
  _addDelayMs?: number;

  /** Simulate a job arriving in the worker with the given queue name. */
  dispatchJob(queueName: string, event: string, data: unknown): Promise<void>;

  /** Simulate a Queue.add() failure for the next call. */
  nextAddError(err: unknown): void;

  reset(): void;
}

export function createFakeBullMQState(): FakeBullMQState {
  const queues: FakeQueueRecord[] = [];
  const workers: FakeWorkerRecord[] = [];

  const state: FakeBullMQState = {
    queues,
    workers,
    _nextAddErrors: [],
    async dispatchJob(queueName: string, event: string, data: unknown) {
      const worker = workers.find(w => w.queueName === queueName && !w.closed);
      if (!worker) throw new Error(`No worker for queue "${queueName}"`);
      const job = { id: `job-${queueName}-${Date.now()}-${Math.random()}`, data };
      try {
        await worker.processor(job);
        for (const h of worker.completedHandlers) h(job);
      } catch (err) {
        for (const h of worker.failedHandlers) h(job, err);
        throw err;
      }
    },
    nextAddError(err: unknown) {
      state._nextAddErrors.push(err);
    },
    reset() {
      queues.length = 0;
      workers.length = 0;
      state._nextAddErrors = [];
      state._nextAddDelays = [];
      state._addDelayMs = undefined;
    },
  };
  return state;
}

export const fakeBullMQState = createFakeBullMQState();

export function createFakeBullMQModule(state: FakeBullMQState = fakeBullMQState) {
  class Queue {
    name: string;
    readonly _record: FakeQueueRecord;
    /** Configurable failed-job count returned by `getJobCounts('failed')`. */
    _failedJobs = 0;

    constructor(name: string) {
      this.name = name;
      this._record = { name, addCalls: [], addErrors: [], closed: false };
      state.queues.push(this._record);
    }

    async add(event: string, data: unknown): Promise<void> {
      const err = state._nextAddErrors.shift();
      if (err) {
        throw err;
      }
      // Optional artificial delay (e.g. simulating a hung Redis) — set per
      // test via `state._nextAddDelays.push(ms)` for one-shot or
      // `state._addDelayMs = ms` for sticky.
      const oneShotDelay = state._nextAddDelays?.shift();
      const stickyDelay = state._addDelayMs ?? 0;
      const delayMs = typeof oneShotDelay === 'number' ? oneShotDelay : stickyDelay;
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
      this._record.addCalls.push({ queueName: this.name, event, data });
    }

    async getJobCounts(...statuses: string[]): Promise<Record<string, number>> {
      const result: Record<string, number> = {};
      for (const s of statuses) {
        result[s] = s === 'failed' ? this._failedJobs : 0;
      }
      return result;
    }

    async close(): Promise<void> {
      this._record.closed = true;
    }
  }

  class Worker {
    readonly _record: FakeWorkerRecord;

    constructor(queueName: string, processor: (job: { data: unknown }) => Promise<void>) {
      this._record = {
        queueName,
        processor,
        errorHandlers: [],
        failedHandlers: [],
        completedHandlers: [],
        closed: false,
      };
      state.workers.push(this._record);
    }

    on(event: 'error', handler: (err: unknown) => void): this;
    on(event: 'failed', handler: (job: unknown, err: unknown) => void): this;
    on(event: 'completed', handler: (job: unknown) => void): this;
    on(
      event: 'error' | 'failed' | 'completed',
      handler:
        | ((err: unknown) => void)
        | ((job: unknown, err: unknown) => void)
        | ((job: unknown) => void),
    ): this {
      if (event === 'error') {
        this._record.errorHandlers.push(handler as (err: unknown) => void);
      }
      if (event === 'failed') {
        this._record.failedHandlers.push(handler as (job: unknown, err: unknown) => void);
      }
      if (event === 'completed') {
        this._record.completedHandlers.push(handler as (job: unknown) => void);
      }
      return this;
    }

    async close(): Promise<void> {
      this._record.closed = true;
    }
  }

  return { Queue, Worker };
}
