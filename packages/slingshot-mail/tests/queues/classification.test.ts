import { describe, expect, it, mock, spyOn } from 'bun:test';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { classifyMailFailure, retryDelayFor } from '../../src/lib/failureClassification.js';
import { createMemoryQueue } from '../../src/queues/memory.js';
import type { MailMessage, MailProvider } from '../../src/types/provider.js';
import { MailSendError } from '../../src/types/provider.js';

spyOn(console, 'warn').mockImplementation(() => {});

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'recipient@example.com',
    subject: 'Test',
    html: '<p>Test</p>',
    ...overrides,
  };
}

/**
 * P-MAIL-7: classify provider failures and retry only the transient ones.
 */
describe('classifyMailFailure', () => {
  it('classifies 408/429/5xx as transient', () => {
    expect(classifyMailFailure(new MailSendError('x', true, 408))).toBe('transient');
    expect(classifyMailFailure(new MailSendError('x', true, 429))).toBe('transient');
    expect(classifyMailFailure(new MailSendError('x', true, 500))).toBe('transient');
    expect(classifyMailFailure(new MailSendError('x', true, 503))).toBe('transient');
  });

  it('classifies non-408/429 4xx as permanent', () => {
    expect(classifyMailFailure(new MailSendError('x', true, 400))).toBe('permanent');
    expect(classifyMailFailure(new MailSendError('x', true, 401))).toBe('permanent');
    expect(classifyMailFailure(new MailSendError('x', true, 403))).toBe('permanent');
    expect(classifyMailFailure(new MailSendError('x', true, 422))).toBe('permanent');
  });

  it('honours retryable=false even when status is missing', () => {
    expect(classifyMailFailure(new MailSendError('x', false))).toBe('permanent');
  });

  it('treats network-level errors (no MailSendError) as transient', () => {
    expect(classifyMailFailure(new TypeError('fetch failed'))).toBe('transient');
  });
});

describe('retryDelayFor', () => {
  it('uses 1s/4s/16s defaults', () => {
    expect(retryDelayFor(1)).toBe(1000);
    expect(retryDelayFor(2)).toBe(4000);
    expect(retryDelayFor(3)).toBe(16000);
    expect(retryDelayFor(99)).toBe(16000);
  });

  it('respects baseDelayMs override (test fast path)', () => {
    expect(retryDelayFor(1, undefined, 0)).toBe(0);
    expect(retryDelayFor(1, undefined, 10)).toBe(10);
    expect(retryDelayFor(2, undefined, 10)).toBe(40);
    expect(retryDelayFor(3, undefined, 10)).toBe(160);
  });

  it('caps provider Retry-After hint at 60s', () => {
    expect(retryDelayFor(1, 600_000)).toBe(60_000);
  });
});

describe('memory queue retry classification (P-MAIL-7)', () => {
  it('retries transient 503 with exponential backoff and dead-letters after exhausting attempts', async () => {
    const onDeadLetter = mock(() => {});
    const provider: MailProvider = {
      name: 'mock',
      send: mock(async () => {
        throw new MailSendError('temporarily unavailable', true, 503);
      }),
    };
    const queue = createMemoryQueue({
      maxAttempts: 3,
      retryBaseDelayMs: 0,
      onDeadLetter,
    });
    await queue.start(provider);
    await queue.enqueue(makeMessage());
    await queue.drain!();
    expect((provider.send as ReturnType<typeof mock>).mock.calls).toHaveLength(3);
    expect(onDeadLetter.mock.calls).toHaveLength(1);
    await queue.stop();
  });

  it('does NOT retry on permanent 422 — emits mail:send.permanentFailure once', async () => {
    const bus = createInProcessAdapter();
    const events: Array<{ event: string; payload: unknown }> = [];
    bus.on('mail:send.permanentFailure' as never, (payload: unknown) => {
      events.push({ event: 'mail:send.permanentFailure', payload });
    });
    const onDeadLetter = mock(() => {});
    const provider: MailProvider = {
      name: 'mock',
      send: mock(async () => {
        throw new MailSendError('invalid recipient', true, 422);
      }),
    };
    const queue = createMemoryQueue({
      maxAttempts: 5,
      retryBaseDelayMs: 0,
      bus,
      onDeadLetter,
    });
    await queue.start(provider);
    await queue.enqueue(makeMessage());
    await queue.drain!();
    expect((provider.send as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect(onDeadLetter.mock.calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { error: { message: string } }).error.message).toContain(
      'invalid',
    );
    await queue.stop();
    await bus.shutdown?.();
  });
});

/**
 * P-MAIL-11: when drain exceeds the configured timeout, the queue emits
 * `mail:drain.timedOut` so the app can persist the still-pending jobs.
 */
describe('memory queue drain timeout event (P-MAIL-11)', () => {
  it('emits mail:drain.timedOut with pending jobs when drain exceeds timeout', async () => {
    const bus = createInProcessAdapter();
    const events: Array<{ event: string; payload: unknown }> = [];
    bus.on('mail:drain.timedOut' as never, (payload: unknown) => {
      events.push({ event: 'mail:drain.timedOut', payload });
    });
    const provider: MailProvider = {
      name: 'mock',
      send: mock(() => new Promise<never>(() => {})),
    };
    const queue = createMemoryQueue({
      drainTimeoutMs: 25,
      sendTimeoutMs: 0,
      bus,
    });
    await queue.start(provider);
    await queue.enqueue(makeMessage());
    await queue.drain!();
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as {
      drainTimeoutMs: number;
      inFlight: number;
      pending: Array<{ id: string }>;
    };
    expect(payload.drainTimeoutMs).toBe(25);
    expect(payload.inFlight).toBeGreaterThan(0);
    expect(payload.pending.length).toBeGreaterThan(0);
    await queue.stop();
    await bus.shutdown?.();
  });
});
