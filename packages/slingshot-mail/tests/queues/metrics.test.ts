/**
 * Unified metrics emitter integration tests for slingshot-mail.
 *
 * Wires an in-process MetricsEmitter into the in-memory queue and asserts
 * that the expected mail.* counters / gauges / timings appear in the snapshot
 * after running representative success and failure workloads.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { createInProcessMetricsEmitter } from '@lastshotlabs/slingshot-core';
import { MailCircuitOpenError } from '../../src/lib/circuitBreaker.js';
import { createMemoryQueue } from '../../src/queues/memory.js';
import { MailSendError } from '../../src/types/provider.js';
import type { MailMessage, MailProvider } from '../../src/types/provider.js';

// Suppress the "not durable" warning emitted by createMemoryQueue.
spyOn(console, 'warn').mockImplementation(() => {});

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'recipient@example.com',
    subject: 'Test',
    html: '<p>Test</p>',
    ...overrides,
  };
}

function makeProvider(
  name: string,
  sendImpl?: () => Promise<{ status: 'sent' | 'queued_by_provider' | 'rejected' }>,
): MailProvider {
  return {
    name,
    send: mock(sendImpl ?? (async () => ({ status: 'sent' as const, raw: null }))),
  };
}

describe('mail queue — metrics emitter', () => {
  it('records mail.send.count success and mail.send.duration on a clean send', async () => {
    const metrics = createInProcessMetricsEmitter();
    const provider = makeProvider('resend');
    const queue = createMemoryQueue({ metrics });
    await queue.start(provider);

    await queue.enqueue(makeMessage());
    await queue.enqueue(makeMessage());
    await queue.drain!();
    await queue.stop();

    const snap = metrics.snapshot();
    const success = snap.counters.find(
      c =>
        c.name === 'mail.send.count' &&
        c.labels.provider === 'resend' &&
        c.labels.result === 'success',
    );
    expect(success?.value).toBe(2);

    const duration = snap.timings.find(
      t => t.name === 'mail.send.duration' && t.labels.provider === 'resend',
    );
    expect(duration?.count).toBe(2);
    expect(duration?.min).toBeGreaterThanOrEqual(0);

    const breaker = snap.gauges.find(
      g => g.name === 'mail.circuitBreaker.state' && g.labels.provider === 'resend',
    );
    expect(breaker?.value).toBe(0);

    const depth = snap.gauges.find(g => g.name === 'mail.queue.depth');
    expect(depth?.value).toBe(0);
  });

  it('records mail.send.count failure and mail.retryAfter when provider returns 429 with Retry-After', async () => {
    const metrics = createInProcessMetricsEmitter();
    let calls = 0;
    const provider: MailProvider = {
      name: 'resend',
      send: mock(async () => {
        calls++;
        // First two attempts hit a 429 with a Retry-After hint; final attempt
        // succeeds so the dead-letter path doesn't fire.
        if (calls < 3) {
          throw new MailSendError('rate limited', true, 429, 'limit', 1500);
        }
        return { status: 'sent' as const };
      }),
    };
    const queue = createMemoryQueue({ maxAttempts: 5, retryBaseDelayMs: 0, metrics });
    await queue.start(provider);
    await queue.enqueue(makeMessage());
    await queue.drain!();
    await queue.stop();

    const snap = metrics.snapshot();
    const failure = snap.counters.find(
      c =>
        c.name === 'mail.send.count' &&
        c.labels.provider === 'resend' &&
        c.labels.result === 'failure',
    );
    expect(failure?.value).toBe(2);

    const success = snap.counters.find(
      c =>
        c.name === 'mail.send.count' &&
        c.labels.provider === 'resend' &&
        c.labels.result === 'success',
    );
    expect(success?.value).toBe(1);

    const retryAfter = snap.gauges.find(
      g => g.name === 'mail.retryAfter' && g.labels.provider === 'resend',
    );
    expect(retryAfter?.value).toBe(1500);
  });

  it('records mail.send.count circuitOpen and gauge state=1 when the breaker rejects', async () => {
    const metrics = createInProcessMetricsEmitter();
    const provider: MailProvider = {
      name: 'sendgrid',
      send: mock(async () => {
        throw new MailCircuitOpenError(
          '[slingshot-mail:sendgrid] open',
          'sendgrid',
          1_000,
        );
      }),
    };
    const queue = createMemoryQueue({
      metrics,
      maxAttempts: 1,
      onDeadLetter: () => {
        // swallow — we just want to observe the metric
      },
    });
    await queue.start(provider);
    await queue.enqueue(makeMessage());
    await queue.drain!();
    await queue.stop();

    const snap = metrics.snapshot();
    const circuitOpen = snap.counters.find(
      c =>
        c.name === 'mail.send.count' &&
        c.labels.provider === 'sendgrid' &&
        c.labels.result === 'circuitOpen',
    );
    expect(circuitOpen?.value).toBe(1);

    const breaker = snap.gauges.find(
      g => g.name === 'mail.circuitBreaker.state' && g.labels.provider === 'sendgrid',
    );
    expect(breaker?.value).toBe(1);
  });

  it('samples mail.queue.depth on each enqueue', async () => {
    const metrics = createInProcessMetricsEmitter();
    const queue = createMemoryQueue({ metrics });
    await queue.enqueue(makeMessage());
    await queue.enqueue(makeMessage());
    await queue.enqueue(makeMessage());

    const snap = metrics.snapshot();
    const depth = snap.gauges.find(g => g.name === 'mail.queue.depth');
    // Last-write-wins on the gauge — three enqueues with no started provider
    // means depth equals 3.
    expect(depth?.value).toBe(3);
  });
});
