/**
 * Auto-close sweep unit tests.
 *
 * Enterprise invariants:
 * - Polls with closesAt in the past get closed
 * - closedBy is null on sweep-closed polls
 * - Polls without closesAt are never swept
 * - closesAt in the future is not swept
 * - Sweep with intervalMs 0 does not run
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { startCloseSweep } from '../../src/lib/closeSweep';
import type { PollAdapter } from '../../src/types/adapters';
import type { PollRecord } from '../../src/types/public';

function makePoll(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    id: 'poll-1',
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    authorId: 'user-author',
    question: 'Pick one',
    options: ['A', 'B', 'C'],
    multiSelect: false,
    anonymous: false,
    closed: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('closeSweep', () => {
  let handle: { stop(): void } | undefined;

  afterEach(() => {
    handle?.stop();
  });

  it('closes polls with closesAt in the past', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const updateFn = mock(async () => makePoll({ closed: true }));
    const emitFn = mock(() => {});

    const adapter: Partial<PollAdapter> = {
      list: async () => ({
        items: [makePoll({ id: 'poll-1', closesAt: pastDate })],
      }),
      update: updateFn,
    };

    handle = startCloseSweep({
      pollAdapter: adapter as PollAdapter,
      bus: { emit: emitFn },
      intervalMs: 50,
    });

    // Wait for at least one tick.
    await new Promise(r => setTimeout(r, 120));

    expect(updateFn).toHaveBeenCalled();
    const [id, data] = updateFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('poll-1');
    expect(data.closed).toBe(true);
    expect(data.closedBy).toBeNull();

    expect(emitFn).toHaveBeenCalledWith(
      'polls:poll.closed',
      expect.objectContaining({
        id: 'poll-1',
        closedBy: null,
      }),
    );
  });

  it('does not sweep polls without closesAt', async () => {
    const updateFn = mock(async () => makePoll());

    const adapter: Partial<PollAdapter> = {
      list: async () => ({
        items: [makePoll({ id: 'poll-2', closesAt: undefined })],
      }),
      update: updateFn,
    };

    handle = startCloseSweep({
      pollAdapter: adapter as PollAdapter,
      bus: { emit: mock(() => {}) },
      intervalMs: 50,
    });

    await new Promise(r => setTimeout(r, 120));
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('does not sweep polls with closesAt in the future', async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const updateFn = mock(async () => makePoll());

    const adapter: Partial<PollAdapter> = {
      list: async () => ({
        items: [makePoll({ id: 'poll-3', closesAt: futureDate })],
      }),
      update: updateFn,
    };

    handle = startCloseSweep({
      pollAdapter: adapter as PollAdapter,
      bus: { emit: mock(() => {}) },
      intervalMs: 50,
    });

    await new Promise(r => setTimeout(r, 120));
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('does not sweep already-closed polls', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const updateFn = mock(async () => makePoll());

    const adapter: Partial<PollAdapter> = {
      list: async () => ({
        items: [makePoll({ id: 'poll-4', closed: true, closesAt: pastDate })],
      }),
      update: updateFn,
    };

    handle = startCloseSweep({
      pollAdapter: adapter as PollAdapter,
      bus: { emit: mock(() => {}) },
      intervalMs: 50,
    });

    await new Promise(r => setTimeout(r, 120));
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('returns a noop handle when intervalMs is 0', () => {
    const emptyObj = {};
    handle = startCloseSweep({
      pollAdapter: emptyObj as unknown as PollAdapter,
      bus: { emit: () => {} },
      intervalMs: 0,
    });

    // Should not throw.
    handle.stop();
  });

  it('stop() clears the interval (no dangling timers)', async () => {
    const updateFn = mock(async () => makePoll());
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    const adapter: Partial<PollAdapter> = {
      list: async () => ({
        items: [makePoll({ id: 'poll-5', closesAt: pastDate })],
      }),
      update: updateFn,
    };

    handle = startCloseSweep({
      pollAdapter: adapter as PollAdapter,
      bus: { emit: mock(() => {}) },
      intervalMs: 50,
    });

    // Stop before any tick fires.
    handle.stop();
    handle = undefined;

    await new Promise(r => setTimeout(r, 120));
    expect(updateFn).not.toHaveBeenCalled();
  });
});
