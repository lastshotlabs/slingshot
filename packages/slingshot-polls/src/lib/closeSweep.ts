/**
 * Auto-close sweep for polls with `closesAt` in the past.
 *
 * Runs on a configurable interval (default 60s). Sweeps for polls where
 * `closed === false` and `closesAt < now`, transitions them to closed,
 * and emits one `polls:poll.closed` event per closed poll.
 *
 * `closedBy` is `null` on sweep-closed polls (no actor); manual close
 * records the caller's userId.
 *
 * @internal
 */
import type { PollAdapter } from '../types/adapters';
import type { PollRecord } from '../types/public';

/** Event bus interface — minimal surface needed by the sweep. */
interface SweepEventBus {
  emit(key: string, payload: Record<string, unknown>): void;
}

/**
 * Start the auto-close sweep interval.
 *
 * @returns A handle with a `stop()` method for graceful shutdown.
 */
export function startCloseSweep({
  pollAdapter,
  bus,
  intervalMs,
}: {
  pollAdapter: PollAdapter;
  bus: SweepEventBus;
  intervalMs: number;
}): { stop(): void } {
  if (intervalMs <= 0) {
    return { stop() {} };
  }

  const timer = setInterval(async () => {
    try {
      const { items: allOpen } = await pollAdapter.list();
      const now = new Date();
      const due = allOpen.filter(
        (p: PollRecord) => !p.closed && p.closesAt && new Date(p.closesAt) <= now,
      );

      for (const poll of due) {
        await pollAdapter.update(poll.id, {
          closed: true,
          closedAt: now,
          closedBy: null,
        });
        bus.emit('polls:poll.closed', {
          id: poll.id,
          sourceType: poll.sourceType,
          sourceId: poll.sourceId,
          scopeId: poll.scopeId,
          closedBy: null,
        });
      }
    } catch {
      // Sweep errors are non-fatal — the next tick retries.
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
