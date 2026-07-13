/**
 * The spend guard.
 *
 * PRE-FLIGHT, not post-hoc. A post-hoc check tells you about the runaway loop
 * after it has finished spending your money; a pre-flight check refuses the next
 * call. `check()` is therefore invoked before every provider call — including
 * every retry and every structured-repair attempt, which is exactly the shape a
 * runaway loop takes.
 *
 * This is the in-memory implementation: correct for a single process, which is
 * what a home-server party game is. F4 replaces the window store with a
 * persisted, cross-process one behind this same interface — nothing in the
 * orchestrator changes.
 */
import type { AiPackageConfig } from '../config';
import { AiSpendLimitError } from '../errors';
import type { AiLogger } from '../provider/types';
import type { SpendStatus } from '../types';

export interface SpendGuard {
  /**
   * Throw if this call could cross the hard limit.
   *
   * `estimateUsd: null` means we cannot price the call — we let it through
   * rather than block on an unknown, but the spend it produces is still recorded
   * as unpriced, which is what surfaces the blind spot.
   */
  check(estimateUsd: number | null): void;
  record(costUsd: number | null): void;
  status(): SpendStatus;
}

const PERIOD_MS: Record<'hour' | 'day' | 'month', number> = {
  hour: 3_600_000,
  day: 86_400_000,
  month: 30 * 86_400_000,
};

export function createSpendGuard(config: AiPackageConfig, logger: AiLogger): SpendGuard {
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
          {
            spentUsd,
            limitUsd: hardLimitUsd,
            estimatedUsd: estimateUsd,
            period,
          },
        );
      }
    },

    record(costUsd) {
      if (!enabled) return;
      roll();
      if (costUsd !== null) spentUsd += costUsd;

      if (!softNotified && softLimitUsd !== undefined && spentUsd >= softLimitUsd) {
        softNotified = true;
        const status = this.status();
        logger.warn(
          `AI spend soft limit reached: $${spentUsd.toFixed(4)} this ${period} ` +
            `(soft limit $${softLimitUsd.toFixed(2)}).`,
          { spentUsd, softLimitUsd, period },
        );
        onSoftLimit?.(status);
      }
    },

    status() {
      roll();
      return {
        period,
        windowStart,
        spentUsd,
        softLimitUsd: softLimitUsd ?? null,
        hardLimitUsd: hardLimitUsd ?? null,
        state: state(),
      };
    },
  };
}
