// ---------------------------------------------------------------------------
// SecurityGate — unified allow/deny decision point for login security layers
// ---------------------------------------------------------------------------
//
// Composes three independent layers into a single, auditable decision surface:
//   1. Credential stuffing detection (distinct accounts per IP / IPs per account)
//   2. Per-identifier rate limiting (failed attempt count over a sliding window)
//   3. Account lockout (hard lock after N consecutive failures)
//
// Pre-auth checks (stuffing + rate limit) are read-only and called before bcrypt.
// Lockout check is read-only and called after bcrypt to prevent timing leaks.
// Mutations (trackFailedLogin, trackAttempt, bustAuthLimit) are consolidated
// into recordLoginFailure / recordLoginSuccess.
import type { LockoutService } from './accountLockout';
import type { LimitOpts } from './authRateLimit';
import type { AuthRateLimitService } from './authRateLimit';
import type { CredentialStuffingService } from './credentialStuffing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityDecision {
  allowed: boolean;
  reason?: 'rate_limited' | 'credential_stuffing' | 'account_locked';
  retryAfterSeconds?: number;
}

export interface SecurityGate {
  /**
   * Pre-bcrypt check: credential stuffing + per-identifier rate limit.
   *
   * @param ip - The client IP address from the request.
   * @param identifier - The submitted login identifier (email, username, etc.).
   * @returns A `SecurityDecision` with `allowed: false` and a `reason` if blocked.
   *
   * @remarks
   * **Must be called BEFORE password verification** to prevent timing-based user
   * enumeration. Blocking early (before bcrypt) means attackers cannot use the
   * response latency difference between "user not found" and "wrong password" to
   * confirm whether an account exists.
   *
   * Checks in order: (1) credential stuffing (`isStuffingBlocked`), then
   * (2) per-identifier rate limit (`isLimited`). Either check blocking causes an
   * immediate `{ allowed: false }` return — the bcrypt call is skipped entirely.
   */
  preAuthCheck(ip: string, identifier: string): Promise<SecurityDecision>;

  /**
   * Post-bcrypt check: account lockout.
   *
   * @param userId - The resolved user ID (only available after password verification).
   * @returns A `SecurityDecision` with `allowed: false` and `retryAfterSeconds` if locked.
   *
   * @remarks
   * **Must be called AFTER password verification** for constant-time security. Placing
   * the lockout check after bcrypt ensures that the response time for a locked account
   * is indistinguishable from a non-existent account (both go through bcrypt first).
   * Moving this check before bcrypt would create a timing oracle: locked accounts would
   * return faster than valid-but-wrong-password attempts.
   *
   * If the lockout service is not configured (`getLockout()` returns `null`), this
   * method always returns `{ allowed: true }`.
   */
  lockoutCheck(userId: string): Promise<SecurityDecision>;

  /**
   * Record a failed credential attempt.
   *
   * @param ip - The client IP address.
   * @param identifier - The submitted login identifier.
   * @returns `{ stuffingNowBlocked }` — `true` when this call crossed a stuffing threshold
   *   for the first time (useful for triggering alerts or notifications).
   *
   * @remarks
   * **Non-idempotent**: this method increments **both** the per-identifier rate-limit
   * counter (via `rateLimit.trackAttempt`) **and** the credential-stuffing sliding-window
   * set (via `credentialStuffing.trackFailedLogin`) in a single call. Calling it more
   * than once for the same failure event will double-count both signals.
   *
   * `stuffingNowBlocked` is `true` only on the **first** call that pushes the count over
   * the configured threshold. Subsequent calls after the threshold is already crossed
   * return `stuffingNowBlocked: false` (the sliding-window set already has the entry).
   * Use the `true` return to trigger a one-time alert (e.g., notify an admin), not to
   * determine whether the current request is blocked — use `preAuthCheck` for that.
   */
  recordLoginFailure(ip: string, identifier: string): Promise<{ stuffingNowBlocked: boolean }>;

  /**
   * Clear security state after a successful login.
   *
   * @param identifier - The login identifier that succeeded.
   *
   * @remarks
   * Clears the per-identifier rate-limit bucket via `rateLimit.bustAuthLimit`. This
   * prevents a user from being locked out of future logins due to earlier failed
   * attempts from their own device. It does **not** clear the credential-stuffing
   * sliding-window set (those are IP-scoped and user-scoped independently) nor the
   * account lockout hard-lock (that requires an explicit admin unlock).
   */
  recordLoginSuccess(identifier: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the unified security gate that composes rate limiting, credential stuffing
 * detection, and account lockout into a single, auditable decision surface.
 *
 * The gate exposes four methods that must be called in order within a login handler:
 * 1. `preAuthCheck(ip, identifier)` — called **before** bcrypt. Checks credential stuffing
 *    and per-identifier rate limit. Returns immediately if blocked; avoids expensive bcrypt
 *    on clearly malicious traffic.
 * 2. `lockoutCheck(userId)` — called **after** bcrypt. Checks whether the account is hard-
 *    locked. Placed after bcrypt intentionally so timing is indistinguishable between a
 *    locked account and a non-existent account.
 * 3. `recordLoginFailure(ip, identifier)` — increments both the rate-limit counter and the
 *    credential stuffing set for the IP/identifier pair. Returns `{ stuffingNowBlocked }`
 *    to signal when a threshold was crossed for the first time (useful for alerting).
 * 4. `recordLoginSuccess(identifier)` — clears the per-identifier rate-limit counter after
 *    a successful login.
 *
 * Credential stuffing and lockout services are resolved lazily via getter functions
 * (passed as `getCredentialStuffing` and `getLockout`) because they may not be configured
 * in all deployments — `null` return values are treated as disabled layers.
 *
 * @param rateLimit - The auth rate limit service (always required).
 * @param getCredentialStuffing - Getter that returns the credential stuffing service, or
 *   `null` when the feature is disabled.
 * @param getLockout - Getter that returns the account lockout service, or `null` when
 *   the feature is disabled.
 * @param loginOpts - Window and maximum attempt configuration for the login rate limit bucket.
 * @returns A `SecurityGate` instance.
 *
 * @example
 * import {
 *   createSecurityGate,
 *   createAuthRateLimitService,
 *   createMemoryAuthRateLimitRepository,
 * } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const gate = createSecurityGate(
 *   createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
 *   () => credentialStuffingService,  // null if not configured
 *   () => lockoutService,             // null if not configured
 *   { windowMs: 60_000, max: 10 },
 * );
 *
 * // In the login route:
 * const pre = await gate.preAuthCheck(ip, email);
 * if (!pre.allowed) return c.json({ error: 'Too many requests' }, 429);
 *
 * const valid = await verifyPassword(password, hash);
 * if (!valid) {
 *   await gate.recordLoginFailure(ip, email);
 *   return c.json({ error: 'Invalid credentials' }, 401);
 * }
 *
 * const lock = await gate.lockoutCheck(userId);
 * if (!lock.allowed) return c.json({ error: 'Account locked' }, 423);
 *
 * await gate.recordLoginSuccess(email);
 */
export function createSecurityGate(
  rateLimit: AuthRateLimitService,
  getCredentialStuffing: () => CredentialStuffingService | null,
  getLockout: () => LockoutService | null,
  loginOpts: LimitOpts,
): SecurityGate {
  const loginKey = (identifier: string) => `login:${identifier}`;

  return {
    async preAuthCheck(ip, identifier) {
      const credentialStuffing = getCredentialStuffing();
      if (credentialStuffing) {
        const blocked = await credentialStuffing.isStuffingBlocked(ip, identifier);
        if (blocked) return { allowed: false, reason: 'credential_stuffing' };
      }

      const limited = await rateLimit.isLimited(loginKey(identifier), loginOpts);
      if (limited) return { allowed: false, reason: 'rate_limited' };

      return { allowed: true };
    },

    async lockoutCheck(userId) {
      const lockout = getLockout();
      if (!lockout) return { allowed: true };

      const locked = await lockout.isAccountLocked(userId);
      if (!locked) return { allowed: true };

      return {
        allowed: false,
        reason: 'account_locked',
        retryAfterSeconds: lockout.config.lockoutDuration,
      };
    },

    async recordLoginFailure(ip, identifier) {
      const credentialStuffing = getCredentialStuffing();
      let stuffingNowBlocked = false;
      if (credentialStuffing) {
        stuffingNowBlocked = await credentialStuffing.trackFailedLogin(ip, identifier);
      }
      await rateLimit.trackAttempt(loginKey(identifier), loginOpts);
      return { stuffingNowBlocked };
    },

    async recordLoginSuccess(identifier) {
      await rateLimit.bustAuthLimit(loginKey(identifier));
    },
  };
}
