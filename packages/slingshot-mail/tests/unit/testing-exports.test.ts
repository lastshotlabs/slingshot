/**
 * Smoke tests for the public `./testing` sub-export.
 *
 * Verifies the factories behave as documented so external consumers (and the
 * mail package's own tests) can lean on them without re-implementing the same
 * stub harness in every file.
 */
import { describe, expect, it } from 'bun:test';
import {
  createStubMailProvider,
  createTestMemoryQueue,
  createTestMessage,
} from '../../src/testing.js';
import { MailSendError } from '../../src/types/provider.js';

describe('slingshot-mail/testing factories', () => {
  it('createTestMessage returns sane defaults and applies overrides', () => {
    const msg = createTestMessage({ subject: 'Hi', tags: { kind: 'welcome' } });
    expect(msg.to).toBe('recipient@example.com');
    expect(msg.subject).toBe('Hi');
    expect(msg.tags).toEqual({ kind: 'welcome' });
  });

  it('createStubMailProvider records calls and falls back to default response', async () => {
    const provider = createStubMailProvider();
    await provider.send(createTestMessage({ subject: 'A' }));
    await provider.send(createTestMessage({ subject: 'B' }));

    expect(provider.callCount()).toBe(2);
    expect(provider.sends.map(m => m.subject)).toEqual(['A', 'B']);
  });

  it('createStubMailProvider plays queued responses in order, then defaults', async () => {
    const provider = createStubMailProvider();
    provider.enqueueResponse({ status: 'sent', messageId: 'first' });
    provider.enqueueResponse(new MailSendError('rate limited', true, 429));

    const ok = await provider.send(createTestMessage());
    expect(ok.messageId).toBe('first');

    const err = await provider.send(createTestMessage()).catch(e => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).statusCode).toBe(429);

    // Falls back to default after queue drains.
    const fallback = await provider.send(createTestMessage());
    expect(fallback.status).toBe('sent');
  });

  it('createStubMailProvider reset() clears recorded sends and queued responses', async () => {
    const provider = createStubMailProvider();
    provider.enqueueResponse(new Error('queued'));
    await provider.send(createTestMessage()).catch(() => {});
    provider.reset();

    expect(provider.callCount()).toBe(0);
    const result = await provider.send(createTestMessage());
    expect(result.status).toBe('sent');
  });

  it('createTestMemoryQueue returns a working queue without spamming console.warn', async () => {
    let warnings = 0;
    const original = console.warn;
    console.warn = () => {
      warnings += 1;
    };
    try {
      const queue = createTestMemoryQueue();
      const provider = createStubMailProvider();
      await queue.start(provider);
      await queue.enqueue(createTestMessage());
      await queue.drain?.();
      await queue.stop();
      expect(provider.callCount()).toBe(1);
    } finally {
      console.warn = original;
    }
    expect(warnings).toBe(0);
  });
});
