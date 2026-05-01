import { noopLogger } from './observability/logger';
import type { Logger } from './observability/logger';

/**
 * Swallow errors from a promise that must never block the main flow.
 *
 * Use for fire-and-forget side effects (metadata updates, notifications,
 * cleanup) where failure is acceptable but should be visible in logs.
 *
 * @param promise - The promise to run best-effort.
 * @param label  - Short context label for the warning (e.g. '[identify]').
 * @param logger - Optional structured logger; defaults to no-op.
 *
 * @example
 *   bestEffort(sessionRepo.updateLastActive(id), '[identify]');
 */
export function bestEffort(promise: Promise<unknown>, label?: string, logger?: Logger): void {
  const log = logger ?? noopLogger;
  promise.catch((err: unknown) => {
    const prefix = label ? `${label} ` : '';
    log.warn(`${prefix}best-effort operation failed`, { err: String(err) });
  });
}
