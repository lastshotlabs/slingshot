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

  /** Simulate a job arriving in the worker with the given queue name. */
  dispatchJob(queueName: string, event: string, data: unknown): Promise<void>;

  /** Simulate a Queue.add() failure for the next call. */
  nextAddError(err: unknown): void;

  reset(): void;
}

export function createFakeBullMQState(): FakeBullMQState {
  const queues: FakeQueueRecord[] = [];
  const workers: FakeWorkerRecord[] = [];
  let nextAddErrors: unknown[] = [];

  return {
    queues,
    workers,
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
      nextAddErrors.push(err);
    },
    reset() {
      queues.length = 0;
      workers.length = 0;
      nextAddErrors = [];
    },
  };
}

export const fakeBullMQState = createFakeBullMQState();

export function createFakeBullMQModule(state: FakeBullMQState = fakeBullMQState) {
  class Queue {
    name: string;
    readonly _record: FakeQueueRecord;
    /** Configurable failed-job count returned by `getJobCounts('failed')`. */
    _failedJobs = 0;

    constructor(name: string, _opts?: unknown) {
      this.name = name;
      this._record = { name, addCalls: [], addErrors: [], closed: false };
      state.queues.push(this._record);
    }

    async add(event: string, data: unknown): Promise<void> {
      const err = (state as any)._nextAddErrors?.shift?.();
      if (err) {
        throw err;
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

  // Patch nextAddError support directly on state internals
  (state as any)._nextAddErrors = (state as any)._nextAddErrors ?? [];
  const origNextAddError = state.nextAddError.bind(state);
  state.nextAddError = (err: unknown) => {
    (state as any)._nextAddErrors = (state as any)._nextAddErrors ?? [];
    (state as any)._nextAddErrors.push(err);
  };

  class Worker {
    readonly _record: FakeWorkerRecord;

    constructor(
      queueName: string,
      processor: (job: { data: unknown }) => Promise<void>,
      _opts?: unknown,
    ) {
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

    on(event: 'error' | 'failed' | 'completed', handler: (...args: any[]) => void): this {
      if (event === 'error') this._record.errorHandlers.push(handler);
      if (event === 'failed') this._record.failedHandlers.push(handler);
      if (event === 'completed') this._record.completedHandlers.push(handler);
      return this;
    }

    async close(): Promise<void> {
      this._record.closed = true;
    }
  }

  return { Queue, Worker };
}
