import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createMemoryQueue } from '../../src/queues/memory.js';

const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

function makeMessage() {
  return {
    to: 'recipient@example.com',
    subject: 'Test',
    html: '<p>Test</p>',
  };
}

describe('createMemoryQueue capacity', () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('dead-letters the oldest job when the queue exceeds capacity', async () => {
    const deadLetterCallback = mock(() => {});
    const queue = createMemoryQueue({ onDeadLetter: deadLetterCallback, maxEntries: 2 });

    await queue.enqueue(makeMessage());
    await queue.enqueue(makeMessage());
    await queue.enqueue(makeMessage());

    expect(await queue.depth!()).toBe(2);
    expect(deadLetterCallback.mock.calls).toHaveLength(1);
    const [job, error] = deadLetterCallback.mock.calls[0] as unknown as [{ id: string }, Error];
    expect(job.id).toBe('1');
    expect(error.message).toContain('capacity');
  });

  it('keeps the queue warning visible for non-durable use', () => {
    createMemoryQueue();
    expect(warnSpy).toHaveBeenCalled();
  });
});
