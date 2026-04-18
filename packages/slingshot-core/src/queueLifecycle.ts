/**
 * Common lifecycle contract shared by domain-specific queue implementations
 * (mail, webhooks, etc.). Plugins reference this type in teardown and health-check
 * code that does not need to know the domain-specific `start()` signature.
 *
 * Each domain queue extends this interface and adds its own `start(arg)` overload.
 *
 * @example
 * ```ts
 * import type { QueueLifecycle } from '@lastshotlabs/slingshot-core';
 *
 * export interface MailQueue extends QueueLifecycle {
 *   start(adapter: MailAdapter): Promise<void>;
 * }
 * ```
 */
export interface QueueLifecycle {
  /** Human-readable queue name (used in logs and health checks). */
  readonly name: string;
  /** Stop the queue worker and reject any pending jobs gracefully. */
  stop(): Promise<void>;
  /**
   * Return the number of jobs currently waiting in the queue.
   * Optional — only implemented by adapters that support depth inspection.
   */
  depth?(): Promise<number>;
  /**
   * Wait for all in-flight jobs to settle (complete or fail).
   * Primarily useful in tests to avoid dangling async work after assertions.
   */
  drain?(): Promise<void>;
}
