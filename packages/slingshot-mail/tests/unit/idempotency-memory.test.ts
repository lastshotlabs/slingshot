import { describe, expect, it, mock, spyOn } from 'bun:test';
import { createMemoryQueue } from '../../src/queues/memory.js';
import type { MailMessage, MailProvider, SendResult } from '../../src/types/provider.js';

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

function makeProvider(): MailProvider {
  return {
    name: 'mock',
    send: mock(async (): Promise<SendResult> => ({ status: 'sent' })),
  };
}

describe('memory queue idempotency', () => {
  it('second enqueue with same idempotencyKey returns the original job id and is a no-op', async () => {
    const queue = createMemoryQueue();
    const provider = makeProvider();
    await queue.start(provider);

    const firstId = await queue.enqueue(makeMessage(), { idempotencyKey: 'evt-1:welcome' });
    const secondId = await queue.enqueue(makeMessage({ subject: 'Different' }), {
      idempotencyKey: 'evt-1:welcome',
    });

    expect(secondId).toBe(firstId);

    await queue.drain!();

    // Only one delivery occurred even though enqueue() was called twice.
    expect((provider.send as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

    await queue.stop();
  });

  it('different idempotencyKeys produce different jobs and both deliver', async () => {
    const queue = createMemoryQueue();
    const provider = makeProvider();
    await queue.start(provider);

    const a = await queue.enqueue(makeMessage(), { idempotencyKey: 'evt-1:welcome' });
    const b = await queue.enqueue(makeMessage(), { idempotencyKey: 'evt-2:welcome' });

    expect(a).not.toBe(b);

    await queue.drain!();
    expect((provider.send as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

    await queue.stop();
  });

  it('omitting idempotencyKey preserves legacy behaviour (each enqueue is a separate job)', async () => {
    const queue = createMemoryQueue();
    const provider = makeProvider();
    await queue.start(provider);

    const a = await queue.enqueue(makeMessage());
    const b = await queue.enqueue(makeMessage());

    expect(a).not.toBe(b);

    await queue.drain!();
    expect((provider.send as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

    await queue.stop();
  });
});
