/**
 * Cron scheduler registry — persists the set of BullMQ scheduler names
 * registered by the current deployment so the next deployment can identify
 * and remove stale schedulers.
 *
 * @remarks
 * When a scheduled job is renamed or removed between deployments, the old BullMQ
 * `RepeatableJob` must be explicitly deleted or it will keep running forever.
 * The cron registry solves this by saving the current deployment's scheduler names
 * at startup, then comparing against the previous deployment's names to find stale ones.
 *
 * @example
 * ```ts
 * import type { CronRegistryRepository } from '@lastshotlabs/slingshot-core';
 *
 * const previousNames = await cronRegistry.getAll();
 * const currentNames = new Set(['daily-digest', 'session-cleanup']);
 *
 * for (const stale of previousNames) {
 *   if (!currentNames.has(stale)) await queue.removeRepeatableByKey(stale);
 * }
 * await cronRegistry.save(currentNames);
 * ```
 */
export interface CronRegistryRepository {
  /** Returns the scheduler names saved by the previous deployment. */
  getAll(): Promise<ReadonlySet<string>>;
  /**
   * Replaces the stored set with the scheduler names from the current deployment.
   *
   * @remarks
   * **Lifecycle timing:** `save()` should be called during the plugin `setupPost` phase,
   * after all cron jobs for the current deployment have been registered (so the complete
   * set of current names is known). Calling it earlier (e.g., in `setupMiddleware` or
   * `setupRoutes`) risks saving an incomplete name set, which would prevent stale
   * schedulers from being detected on the next deployment.
   *
   * The call atomically replaces the previous deployment's name set — it does not merge.
   */
  save(names: ReadonlySet<string>): Promise<void>;
}
