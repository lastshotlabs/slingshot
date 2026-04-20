import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('bullmq', () => ({
  default: {
    Queue: class MockQueue {},
    Worker: class MockWorker {},
    UnrecoverableError: class MockUnrecoverableError extends Error {},
  },
  Queue: class MockQueue {},
  Worker: class MockWorker {},
  UnrecoverableError: class MockUnrecoverableError extends Error {},
}));

mock.module('ioredis', () => {
  throw new Error("Cannot find package 'ioredis'");
});

let createBullMQWebhookQueue: typeof import('../../packages/slingshot-webhooks/src/queues/bullmq').createBullMQWebhookQueue;

beforeAll(async () => {
  ({ createBullMQWebhookQueue } =
    await import('../../packages/slingshot-webhooks/src/queues/bullmq'));
});

describe('webhook BullMQ queue missing ioredis dependency', () => {
  it('surfaces an install error when ioredis cannot be imported', async () => {
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue requires ioredis to be installed. Run: bun add ioredis',
    );
  });
});
