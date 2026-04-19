import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('bullmq', () => {
  throw new Error("Cannot find package 'bullmq'");
});

mock.module('ioredis', () => ({
  default: class MockRedis {
    async ping() {
      return 'PONG';
    }
  },
}));

let createBullMQWebhookQueue: typeof import('../../packages/slingshot-webhooks/src/queues/bullmq').createBullMQWebhookQueue;

beforeAll(async () => {
  ({ createBullMQWebhookQueue } = await import(
    '../../packages/slingshot-webhooks/src/queues/bullmq'
  ));
});

describe('webhook BullMQ queue missing bullmq dependency', () => {
  it('surfaces an install error when bullmq cannot be imported', async () => {
    const queue = createBullMQWebhookQueue({
      redis: 'redis://localhost:6379',
    });

    await expect(queue.start(async () => {})).rejects.toThrow(
      'BullMQ webhook queue requires bullmq to be installed. Run: bun add bullmq',
    );
  });
});
