import { describe, expect, test } from 'bun:test';
import {
  TEST_ADAPTER_TIMEOUT_MS,
  classifyOrchestrationError,
  FakeRedisClient,
  FakeJob,
  FakeQueue,
  FakeQueueEvents,
  FakeWorker,
  createFakeBullMQModule,
  resetFakeBullMQState,
} from '../src/testing';

describe('orchestration BullMQ testing entrypoint', () => {
  test('exports test defaults and classification helpers', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

    expect(TEST_ADAPTER_TIMEOUT_MS).toBe(10_000);
    expect(classifyOrchestrationError(err)).toEqual({
      retryable: true,
      permanent: false,
      code: 'ECONNRESET',
    });
  });

  test('exports FakeRedisClient', () => {
    const client = new FakeRedisClient();
    expect(typeof client.get).toBe('function');
    expect(typeof client.set).toBe('function');
    expect(typeof client.mget).toBe('function');
    expect(typeof client.zadd).toBe('function');
    expect(typeof client.zrange).toBe('function');
    expect(typeof client.del).toBe('function');
    expect(typeof client.reset).toBe('function');
  });

  test('exports FakeJob', () => {
    const queue = new FakeQueue('test');
    const job = new FakeJob({ queue, id: 'j1', name: 'test-job', data: { x: 1 } });
    expect(job.id).toBe('j1');
    expect(typeof job.getState).toBe('function');
    expect(typeof job.remove).toBe('function');
    expect(typeof job.moveToFailed).toBe('function');
  });

  test('exports FakeQueue', () => {
    const queue = new FakeQueue('test-queue');
    expect(queue.name).toBe('test-queue');
    expect(typeof queue.add).toBe('function');
    expect(typeof queue.getJobs).toBe('function');
    expect(typeof queue.close).toBe('function');
  });

  test('exports FakeQueueEvents', () => {
    const events = new FakeQueueEvents('test-events');
    expect(typeof events.on).toBe('function');
    expect(typeof events.off).toBe('function');
    expect(typeof events.close).toBe('function');
  });

  test('exports FakeWorker', () => {
    const worker = new FakeWorker('test-worker', async () => {}, {});
    expect(typeof worker.on).toBe('function');
    expect(typeof worker.pause).toBe('function');
    expect(typeof worker.getActiveCount).toBe('function');
    expect(typeof worker.close).toBe('function');
  });

  test('createFakeBullMQModule returns module shape', () => {
    const mod = createFakeBullMQModule();
    expect(mod).toHaveProperty('Queue');
    expect(mod).toHaveProperty('QueueEvents');
    expect(mod).toHaveProperty('Worker');
    expect(mod.Job).toHaveProperty('fromId');
  });

  test('resetFakeBullMQState clears static instances', () => {
    const q1 = new FakeQueue('q1');
    const w1 = new FakeWorker('w1', async () => {}, {});
    expect(FakeQueue.instances.length).toBeGreaterThanOrEqual(1);
    expect(FakeWorker.instances.length).toBeGreaterThanOrEqual(1);

    resetFakeBullMQState();

    expect(FakeQueue.instances).toHaveLength(0);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
