import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createBullMQMailQueue } from '../../src/queues/bullmq.js';
import type { MailProvider, SendResult } from '../../src/types/provider.js';

// ---------------------------------------------------------------------------
// Mocks MUST come before the import of the module under test so Bun's hoisted
// mock.module() replaces bullmq + ioredis before bullmq.ts dynamically imports
// them inside start().
// ---------------------------------------------------------------------------

// Simulate BullMQ's jobId-based deduplication. Repeated add() with the same
// jobId returns the original job without producing a second delivery.
const seenJobIds = new Map<string, { id: string; data: unknown }>();
const mockQueueAdd = mock(async (_name: string, data: unknown, opts?: { jobId?: string }) => {
  if (opts?.jobId !== undefined) {
    const existing = seenJobIds.get(opts.jobId);
    if (existing) return existing;
    const job = { id: opts.jobId, data };
    seenJobIds.set(opts.jobId, job);
    return job;
  }
  // Auto-generated id when caller did not supply jobId.
  return { id: `auto-${seenJobIds.size + 1}`, data };
});
const mockQueueClose = mock(async () => {});
const mockQueueCount = mock(async () => 0);

const mockWorkerClose = mock(async () => {});
const mockWorkerOn = mock(() => {});

function MockQueue(this: unknown) {
  return {
    add: mockQueueAdd,
    close: mockQueueClose,
    count: mockQueueCount,
  };
}

function MockWorker(this: unknown) {
  return {
    close: mockWorkerClose,
    on: mockWorkerOn,
  };
}

class MockUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

const mockPing = mock(async () => 'PONG');
const mockQuit = mock(async () => {});

function MockIORedis(this: unknown) {
  return { ping: mockPing, quit: mockQuit };
}

mock.module('bullmq', () => ({
  Queue: MockQueue,
  Worker: MockWorker,
  UnrecoverableError: MockUnrecoverableError,
}));

mock.module('ioredis', () => ({
  default: MockIORedis,
  Redis: MockIORedis,
}));

function makeProvider(): MailProvider {
  return {
    name: 'mock',
    send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
  };
}

beforeEach(() => {
  seenJobIds.clear();
  mockQueueAdd.mockClear();
});

describe('BullMQ queue idempotency', () => {
  it('passes idempotencyKey as BullMQ jobId so repeated enqueues dedup at the queue boundary', async () => {
    const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
    await q.start(makeProvider());

    const msg = { to: 'u@example.com', subject: 'Hi', html: '<p>hi</p>' };

    const firstId = await q.enqueue(msg, { idempotencyKey: 'evt-abc:welcome' });
    const secondId = await q.enqueue(msg, { idempotencyKey: 'evt-abc:welcome' });

    expect(firstId).toBe('evt-abc:welcome');
    expect(secondId).toBe(firstId);

    // Both add() calls forwarded the same jobId. BullMQ semantics guarantee a
    // global no-op for duplicates; our mock asserts the call shape.
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    const call0 = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { jobId?: string }];
    const call1 = mockQueueAdd.mock.calls[1] as unknown as [string, unknown, { jobId?: string }];
    expect(call0[2]?.jobId).toBe('evt-abc:welcome');
    expect(call1[2]?.jobId).toBe('evt-abc:welcome');

    // The simulated BullMQ behaviour returns the original job — only one job exists.
    expect(seenJobIds.size).toBe(1);

    await q.stop();
  });

  it('omitting idempotencyKey leaves jobId unset so BullMQ generates a fresh id per enqueue', async () => {
    const q = createBullMQMailQueue({ redis: { host: 'localhost' } });
    await q.start(makeProvider());

    const msg = { to: 'u@example.com', subject: 'Hi', html: '<p>hi</p>' };

    await q.enqueue(msg);
    await q.enqueue(msg);

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    const opts0 = (
      mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { jobId?: string }]
    )[2];
    const opts1 = (
      mockQueueAdd.mock.calls[1] as unknown as [string, unknown, { jobId?: string }]
    )[2];
    expect(opts0?.jobId).toBeUndefined();
    expect(opts1?.jobId).toBeUndefined();

    await q.stop();
  });
});
