/**
 * Swallow errors from a promise that must never block the main flow.
 *
 * Use for fire-and-forget side effects (metadata updates, notifications,
 * cleanup) where failure is acceptable but should be visible in logs.
 *
 * @param promise - The promise to run best-effort.
 * @param label  - Short context label for the warning (e.g. '[identify]').
 *
 * @example
 *   bestEffort(sessionRepo.updateLastActive(id), '[identify]');
 */
export function bestEffort(promise: Promise<unknown>, label?: string): void {
  promise.catch((err: unknown) => {
    const prefix = label ? `${label} ` : '';
    console.warn(`${prefix}best-effort operation failed:`, err);
  });
}
