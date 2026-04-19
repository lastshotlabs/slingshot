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

mock.module('ioredis', () => ({}));

let createBullMQWebhookQueue: typeof import('../../packages/slingshot-webhooks/src/queues/bullmq').createBullMQWebhookQueue;

beforeAll(async () => {
  ({ createBullMQWebhookQueue } = await import(
    '../../packages/slingshot-webhooks/src/queues/bullmq'
  ));
});

describe('webhook BullMQ queue ioredis export validation', () => {
  it('rejects missing ioredis Redis constructors with a clear error', async () => {
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue requires ioredis to export a Redis constructor',
    );
  });
});
