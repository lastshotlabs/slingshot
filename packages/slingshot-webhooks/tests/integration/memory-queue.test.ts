import { describe, expect, it, mock } from 'bun:test';
import { createWebhookMemoryQueue } from '../../src/queues/memory';
import { WebhookDeliveryError } from '../../src/types/queue';
import type { WebhookJob } from '../../src/types/queue';

function makeJob(overrides?: Partial<WebhookJob>): Omit<WebhookJob, 'id' | 'createdAt'> {
  return {
    deliveryId: 'del-1',
    endpointId: 'ep-1',
    url: 'https://example.com/hook',
    secret: 'secret',
    event: 'auth:user.created',
    payload: '{}',
    attempts: 0,
    ...overrides,
  };
}

describe('memory queue', () => {
  it('calls processor for enqueued job', async () => {
    const processorMock = mock(async (_job: WebhookJob) => {});
    const q = createWebhookMemoryQueue({ maxAttempts: 3 });
    await q.start(processorMock);
    await q.enqueue(makeJob());
    // Allow microtask queue to flush
    await new Promise(r => setTimeout(r, 10));
    expect(processorMock).toHaveBeenCalledTimes(1);
    await q.stop();
  });

  it('retries on failure up to maxAttempts, then calls onDeadLetter', async () => {
    const deadLetterMock = mock((_job: WebhookJob, _err: Error) => {});
    let callCount = 0;
    const processor = async (_job: WebhookJob) => {
      callCount++;
      throw new Error('delivery failed');
    };
    const q = createWebhookMemoryQueue({ maxAttempts: 3, onDeadLetter: deadLetterMock });
    await q.start(processor);
    await q.enqueue(makeJob());
    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(3);
    expect(deadLetterMock).toHaveBeenCalledTimes(1);
    await q.stop();
  });

  it('depth decreases after job is processed', async () => {
    const q = createWebhookMemoryQueue({ maxAttempts: 1 });
    const processorMock = mock(async (_job: WebhookJob) => {});
    await q.start(processorMock);

    expect(await q.depth!()).toBe(0);
    await q.enqueue(makeJob());
    // Allow processing
    await new Promise(r => setTimeout(r, 30));
    expect(await q.depth!()).toBe(0);
    await q.stop();
  });

  it('depth reflects pending jobs before processing', async () => {
    const q = createWebhookMemoryQueue({ maxAttempts: 1 });
    // Don't start — no processor, jobs just accumulate
    await q.enqueue(makeJob());
    await q.enqueue(makeJob({ deliveryId: 'del-2' }));
    expect(await q.depth!()).toBe(2);
    await q.stop();
  });

  it('stops immediately on non-retryable error', async () => {
    const deadLetterMock = mock((_job: WebhookJob, _err: Error) => {});
    let callCount = 0;
    const processor = async (_job: WebhookJob) => {
      callCount++;
      throw new WebhookDeliveryError('permanent failure', false, 400);
    };
    const q = createWebhookMemoryQueue({ maxAttempts: 5, onDeadLetter: deadLetterMock });
    await q.start(processor);
    await q.enqueue(makeJob());
    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(1);
    expect(deadLetterMock).toHaveBeenCalledTimes(1);
    await q.stop();
  });
});
