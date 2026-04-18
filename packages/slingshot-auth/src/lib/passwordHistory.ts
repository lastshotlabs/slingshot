import type { AuthAdapter, RuntimePassword } from '@lastshotlabs/slingshot-core';

/**
 * Check whether a plaintext password matches any of the stored history hashes.
 * Returns `true` if the password is **not** reused (safe to use), `false` if it was
 * found in the history. Skips the check if the adapter does not implement
 * `getPasswordHistory` or if `maxCount <= 0`.
 *
 * @param adapter - The auth adapter providing `getPasswordHistory`.
 * @param userId - The user whose password history should be checked.
 * @param newPasswordPlaintext - The candidate plaintext password to test against history.
 * @param maxCount - How many historical hashes to check. Pass `0` to disable the check.
 * @param passwordRuntime - Optional password hashing runtime (defaults to `Bun.password`).
 * @returns `true` when the password is safe to use; `false` when it matches a stored hash.
 *
 * @example
 * // In a password-change route, before calling setPassword:
 * const notReused = await checkPasswordNotReused(
 *   adapter,
 *   userId,
 *   newPassword,
 *   config.passwordPolicy?.preventReuse ?? 0,
 * );
 * if (!notReused) {
 *   throw new HttpError(400, 'Password was recently used. Choose a different password.');
 * }
 */
export async function checkPasswordNotReused(
  adapter: AuthAdapter,
  userId: string,
  newPasswordPlaintext: string,
  maxCount: number,
  passwordRuntime?: RuntimePassword,
): Promise<boolean> {
  if (maxCount <= 0) return true;
  if (!adapter.getPasswordHistory) return true;

  const history = await adapter.getPasswordHistory(userId);
  if (history.length === 0) return true;

  for (const hash of history) {
    if (await (passwordRuntime ?? Bun.password).verify(newPasswordPlaintext, hash)) {
      return false; // reused
    }
  }
  return true; // not reused
}

/**
 * Record a newly-set password hash into the user's password history.
 * No-op if the adapter does not implement `addPasswordToHistory` or if `maxCount <= 0`.
 *
 * @param adapter - The auth adapter providing `addPasswordToHistory`.
 * @param userId - The user whose history entry should be added.
 * @param newHash - The bcrypt/argon2 hash of the newly set password.
 * @param maxCount - The maximum number of historical hashes to retain. The adapter
 *   is responsible for evicting the oldest entries when the limit is exceeded.
 *
 * @example
 * // After successfully calling adapter.setPassword:
 * await recordPasswordChange(
 *   adapter,
 *   userId,
 *   newPasswordHash,
 *   config.passwordPolicy?.preventReuse ?? 0,
 * );
 */
export async function recordPasswordChange(
  adapter: AuthAdapter,
  userId: string,
  newHash: string,
  maxCount: number,
): Promise<void> {
  if (maxCount <= 0) return;
  if (!adapter.addPasswordToHistory) return;
  await adapter.addPasswordToHistory(userId, newHash, maxCount);
}
