import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

/**
 * Suspends or unsuspends a user account.
 *
 * Delegates to the adapter's `setSuspended` method when implemented. When the adapter
 * does not implement `setSuspended` the call is silently ignored (no-op). This allows
 * the auth plugin to call `setSuspended` unconditionally without requiring every adapter
 * to implement suspension support.
 *
 * @param adapter - The active `AuthAdapter` instance (from the auth runtime).
 * @param userId - The ID of the user to suspend or unsuspend.
 * @param suspended - `true` to suspend the account, `false` to lift the suspension.
 * @param reason - Optional human-readable reason for the suspension (e.g., `'Violated terms of service'`).
 *   Only stored when the adapter supports it; ignored otherwise.
 * @returns A `Promise<void>` that resolves when the operation is complete (or immediately
 *   if the adapter does not support suspension).
 *
 * @example
 * import { setSuspended } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * // Suspend a user from an admin route
 * await setSuspended(runtime.adapter, userId, true, 'Spam account');
 *
 * // Lift a suspension
 * await setSuspended(runtime.adapter, userId, false);
 */
export async function setSuspended(
  adapter: AuthAdapter,
  userId: string,
  suspended: boolean,
  reason?: string,
): Promise<void> {
  if (adapter.setSuspended) {
    await adapter.setSuspended(userId, suspended, reason);
  }
}

/**
 * Retrieves the suspension status of a user account.
 *
 * Delegates to the adapter's `getSuspended` method when implemented. Returns
 * `{ suspended: false }` when the adapter does not implement `getSuspended`, or when
 * `getSuspended` returns `null`. This provides a safe default so callers (including
 * `createIdentifyMiddleware`) can call `getSuspended` unconditionally.
 *
 * @param adapter - The active `AuthAdapter` instance (from the auth runtime).
 * @param userId - The ID of the user whose suspension status to retrieve.
 * @returns A `Promise` resolving to `{ suspended: boolean; suspendedReason?: string }`.
 *   `suspended` is `false` when the adapter does not support suspension or when the
 *   user has not been suspended.
 *
 * @example
 * import { getSuspended } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const { suspended, suspendedReason } = await getSuspended(runtime.adapter, userId);
 * if (suspended) {
 *   return c.json({ error: `Account suspended: ${suspendedReason ?? 'no reason given'}` }, 403);
 * }
 */
export async function getSuspended(
  adapter: AuthAdapter,
  userId: string,
): Promise<{ suspended: boolean; suspendedReason?: string }> {
  if (adapter.getSuspended) {
    const result = await adapter.getSuspended(userId);
    return result ?? { suspended: false };
  }
  return { suspended: false };
}
