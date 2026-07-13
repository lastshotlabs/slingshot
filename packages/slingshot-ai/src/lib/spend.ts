/**
 * The spend guard.
 *
 * PRE-FLIGHT, not post-hoc. A post-hoc check tells you about the runaway loop
 * after it has finished spending your money; a pre-flight check refuses the next
 * call. `check()` therefore runs before EVERY provider call — including every
 * retry and every structured-repair attempt, which are precisely the two shapes
 * an accidental bill takes.
 *
 * `hydrate()` rebuilds the current window from the persisted usage ledger at
 * boot. Without it a crash-loop would reset the budget to zero on every restart
 * — the one failure mode a spend limit exists to prevent, and it would do so
 * silently.
 */
import type { AiPackageConfig } from '../config';
import { AiSpendLimitError } from '../errors';
import type { AiLogger } from '../provider/types';
import type { SpendStatus } from '../types';
import type { AiEventBus } from './seams';

export interface SpendGuard {
  /**
   * Throw if this call could cross the hard limit.
   *
   * `estimateUsd: null` means we cannot price the call. We let it through rather
   * than block on an unknown — refusing every call to an unpriced local model
   * would be absurd — but the spend it produces is still recorded as unpriced,
   * which surfaces the blind spot instead of hiding it.
   */
  check(estimateUsd: number | null): void;
  record(costUsd: number | null): void;
  status(): SpendStatus;
  /** Seed the current window from persisted usage. Called once, at `setupPost`. */
  hydrate(spentUsd: number): void;
}

const PERIOD_MS: Record<'hour' | 'day' | 'month', number> = {
  hour: 3_600_000,
  day: 86_400_000,
  month: 30 * 86_400_000,
};

/** The start of the current window. Exported so boot hydration knows what to query. */
export function windowStartFor(period: 'hour' | 'day' | 'month', now = Date.now()): Date {
  return new Date(now - PERIOD_MS[period]);
}

export function createSpendGuard(
  config: AiPackageConfig,
  logger: AiLogger,
  bus?: AiEventBus,
): SpendGuard {
  const { enabled, period, softLimitUsd, hardLimitUsd, onSoftLimit } = config.spend;
  const windowMs = PERIOD_MS[period];

  let windowStart = Date.now();
  let spentUsd = 0;
  let softNotified = false;

  function roll(): void {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      spentUsd = 0;
      softNotified = false;
    }
  }

  function state(): 'ok' | 'soft' | 'hard' {
    if (hardLimitUsd !== undefined && spentUsd >= hardLimitUsd) return 'hard';
    if (softLimitUsd !== undefined && spentUsd >= softLimitUsd) return 'soft';
    return 'ok';
  }

  function snapshot(): SpendStatus {
    return {
      period,
      windowStart,
      spentUsd,
      softLimitUsd: softLimitUsd ?? null,
      hardLimitUsd: hardLimitUsd ?? null,
      state: state(),
    };
  }

  return {
    check(estimateUsd) {
      if (!enabled || hardLimitUsd === undefined) return;
      roll();
      const projected = spentUsd + (estimateUsd ?? 0);
      if (projected > hardLimitUsd) {
        throw new AiSpendLimitError(
          `AI spend limit reached: $${spentUsd.toFixed(4)} spent this ${period}, and this call ` +
            `could cost up to $${(estimateUsd ?? 0).toFixed(4)}, which would exceed the hard limit ` +
            `of $${hardLimitUsd.toFixed(2)}. The call was not made.`,
          { spentUsd, limitUsd: hardLimitUsd, estimatedUsd: estimateUsd, period },
        );
      }
    },

    record(costUsd) {
      if (!enabled) return;
      roll();
      if (costUsd !== null) spentUsd += costUsd;

      // Once per period, not once per call. An alert that re-fires on every
      // subsequent request is an alert that gets muted — and a muted spend alert
      // is worse than none, because it reads as "nothing is wrong".
      if (!softNotified && softLimitUsd !== undefined && spentUsd >= softLimitUsd) {
        softNotified = true;
        const current = snapshot();
        logger.warn(
          `AI spend soft limit reached: $${spentUsd.toFixed(4)} this ${period} ` +
            `(soft limit $${softLimitUsd.toFixed(2)}).`,
          { spentUsd, softLimitUsd, period },
        );
        // Best-effort: a listener that throws must not fail the generation the
        // caller is currently waiting on.
        try {
          bus?.emit('ai:spend.soft_limit', current);
        } catch {
          // Intentionally swallowed — see above.
        }
        onSoftLimit?.(current);
      }
    },

    hydrate(persistedUsd) {
      if (!enabled) return;
      spentUsd = persistedUsd;
      // Already over the soft limit at boot? Don't re-alert — that alert fired
      // before the restart, and re-firing it on every deploy trains people to
      // ignore it.
      softNotified = softLimitUsd !== undefined && spentUsd >= softLimitUsd;
      if (persistedUsd > 0) {
        logger.info(
          `AI spend guard restored $${persistedUsd.toFixed(4)} of spend for the current ${period} ` +
            `from the usage ledger.`,
          { spentUsd: persistedUsd, period },
        );
      }
    },

    status() {
      roll();
      return snapshot();
    },
  };
}
