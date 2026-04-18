/**
 * BullMQ soak tests — require a real Redis instance.
 *
 * Run with:
 *   REDIS_URL=redis://localhost:6379 bun test packages/slingshot-mail/tests/smoke/bullmq.soak.test.ts
 *
 * Skipped automatically when REDIS_URL is not set.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createBullMQMailQueue } from '../../src/queues/bullmq.js';
import { MailSendError } from '../../src/types/provider.js';
import type { MailProvider } from '../../src/types/provider.js';

const REDIS_URL = process.env.REDIS_URL;
const SKIP = !REDIS_URL;

/** Poll condition every intervalMs until true or timeoutMs elapses. */
function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (await condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor: timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function makeQueueName(suffix: string): string {
  return `slingshot-mail-soak-${Date.now()}-${suffix}`;
}

describe.skipIf(SKIP)('BullMQ soak (requires REDIS_URL)', () => {
  // Each test gets its own queue name to avoid cross-test contamination.
  // stop() is called inside each test to ensure cleanup even on failure.

  it('processes 500 jobs successfully under concurrent load', async () => {
    let processed = 0;
    const provider: MailProvider = {
      name: 'soak',
      async send() {
        processed++;
        return { status: 'sent' as const };
      },
    };

    const JOBS = 500;
    const q = createBullMQMailQueue({ redis: REDIS_URL!, queueName: makeQueueName('success') });
    await q.start(provider);

    await Promise.all(
      Array.from({ length: JOBS }, (_, i) =>
        q.enqueue({ to: `u${i}@example.com`, subject: `Job ${i}`, html: `<p>${i}</p>` }),
      ),
    );

    await waitFor(() => processed >= JOBS, 30_000);
    expect(processed).toBe(JOBS);

    await q.stop();
  }, 35_000);

  it('non-retryable errors dead-letter immediately without consuming retry budget', async () => {
    const deadLettered: string[] = [];
    let processed = 0;

    const TOTAL = 100;
    const NON_RETRYABLE = 20;

    // Jobs with index < NON_RETRYABLE throw a permanent error; the rest succeed.
    const provider: MailProvider = {
      name: 'soak-mixed',
      async send(message) {
        const idx = parseInt(message.subject.replace('Job ', ''));
        if (idx < NON_RETRYABLE) {
          throw new MailSendError(`Rejected: job ${idx}`, false, 422);
        }
        processed++;
        return { status: 'sent' as const };
      },
    };

    const q = createBullMQMailQueue({
      redis: REDIS_URL!,
      queueName: makeQueueName('nonretry'),
      maxAttempts: 3,
      onDeadLetter: job => {
        deadLettered.push(job.id);
      },
    });
    await q.start(provider);

    await Promise.all(
      Array.from({ length: TOTAL }, (_, i) =>
        q.enqueue({ to: 'u@example.com', subject: `Job ${i}`, html: `<p>${i}</p>` }),
      ),
    );

    await waitFor(() => processed + deadLettered.length >= TOTAL, 30_000);

    expect(processed).toBe(TOTAL - NON_RETRYABLE);
    expect(deadLettered.length).toBe(NON_RETRYABLE);

    await q.stop();
  }, 35_000);

  it('retryable errors exhaust retry budget then dead-letter', async () => {
    const deadLettered: string[] = [];
    let attempts = 0;

    const MAX_ATTEMPTS = 3;
    const JOBS = 10;

    // Every job always throws a retryable error — all should exhaust retries and dead-letter.
    const provider: MailProvider = {
      name: 'soak-flaky',
      async send() {
        attempts++;
        throw new MailSendError('Service temporarily unavailable', true, 503);
      },
    };

    const q = createBullMQMailQueue({
      redis: REDIS_URL!,
      queueName: makeQueueName('retryexhaust'),
      maxAttempts: MAX_ATTEMPTS,
      retryBaseDelayMs: 100, // fast retries for the test
      onDeadLetter: job => {
        deadLettered.push(job.id);
      },
    });
    await q.start(provider);

    await Promise.all(
      Array.from({ length: JOBS }, (_, i) =>
        q.enqueue({ to: 'u@example.com', subject: `Job ${i}`, html: `<p>${i}</p>` }),
      ),
    );

    await waitFor(() => deadLettered.length >= JOBS, 30_000);

    expect(deadLettered.length).toBe(JOBS);
    // Each job attempted MAX_ATTEMPTS times before dead-lettering
    expect(attempts).toBe(JOBS * MAX_ATTEMPTS);

    await q.stop();
  }, 35_000);

  it('depth() reflects pending job count', async () => {
    // Provider that blocks until released so jobs stay in-flight
    let release: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });

    const provider: MailProvider = {
      name: 'soak-depth',
      async send() {
        await gate;
        return { status: 'sent' as const };
      },
    };

    const q = createBullMQMailQueue({
      redis: REDIS_URL!,
      queueName: makeQueueName('depth'),
    });
    await q.start(provider);

    const JOBS = 20;
    await Promise.all(
      Array.from({ length: JOBS }, (_, i) =>
        q.enqueue({ to: 'u@example.com', subject: `Job ${i}`, html: `<p>${i}</p>` }),
      ),
    );

    const depthAfterEnqueue = await q.depth!();
    expect(depthAfterEnqueue).toBeGreaterThan(0);

    // Release all blocked jobs and wait for queue to drain
    release!();
    await waitFor(async () => (await q.depth!()) === 0, 15_000);

    expect(await q.depth!()).toBe(0);

    await q.stop();
  }, 20_000);
});
