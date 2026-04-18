import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { BreachedPasswordConfig } from '../config/authConfig';

export type { BreachedPasswordConfig };

/**
 * Checks whether a password has appeared in a known data breach using the
 * HaveIBeenPwned (HIBP) k-Anonymity API.
 *
 * **k-Anonymity**: the password is SHA-1 hashed and only the first 5 hex characters
 * are sent to the HIBP API. The API returns all hashes sharing that prefix; the full
 * hash is compared locally. The complete password hash (and therefore the password
 * itself) never leaves the server.
 *
 * @param password - The plain-text password to check. Hashed locally; never transmitted.
 * @param config - Optional configuration for timeout, minimum breach count threshold, and
 *   API failure policy.
 * @param config.timeout - Request timeout in milliseconds. Defaults to `3000`.
 * @param config.minBreachCount - Minimum number of breach appearances before the password
 *   is considered compromised. Defaults to `1` (any appearance counts).
 * @param config.onApiFailure - Policy when the HIBP API is unreachable or returns an error.
 *   `'block'` (default): fail-closed, treat as breached (count: -1). `'allow'`: fail-open,
 *   treat as not breached.
 * @param context - Optional request context used for event metadata only (not sent to HIBP).
 * @param context.userId - ID of the user attempting to set the password.
 * @param context.ip - Client IP address for observability.
 * @param context.requestId - Trace/request ID for log correlation.
 * @param context.sessionId - Session ID for log correlation.
 * @param eventBus - Optional event bus. When provided, emits:
 *   - `security.breached_password.api_failure` on network/HTTP errors
 *   - `security.breached_password.detected` when a breach is found above the threshold
 * @returns An object `{ breached: boolean; count: number }` where `count` is the number
 *   of times the password appeared in HIBP's dataset (`-1` when `onApiFailure: 'block'`
 *   triggers, `0` when the API failed and the policy is `'allow'`).
 *
 * @throws Never throws — all network errors and API failures are caught internally and
 *   handled according to `config.onApiFailure`.
 *
 * @example
 * import { checkBreachedPassword } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const result = await checkBreachedPassword(
 *   newPassword,
 *   { timeout: 2000, minBreachCount: 5, onApiFailure: 'allow' },
 *   { userId: c.get('authUserId') ?? undefined, ip: getClientIp(c) ?? undefined },
 *   runtime.eventBus,
 * );
 * if (result.breached) {
 *   return c.json({ error: 'This password has appeared in a known data breach. Choose a different password.' }, 422);
 * }
 */
export async function checkBreachedPassword(
  password: string,
  config?: BreachedPasswordConfig,
  context?: { userId?: string; ip?: string; requestId?: string; sessionId?: string },
  eventBus?: SlingshotEventBus,
): Promise<{ breached: boolean; count: number }> {
  const timeout = config?.timeout ?? 3000;
  const minCount = config?.minBreachCount ?? 1;

  // SHA-1 the password
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

  const prefix = hashHex.slice(0, 5);
  const suffix = hashHex.slice(5);

  let responseText: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: { 'Add-Padding': 'true' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HIBP API returned ${res.status}`);
    responseText = await res.text();
  } catch {
    // API failure — emit an observable event regardless of which policy applies,
    // then apply onApiFailure policy (default: 'block', i.e. fail-closed).
    eventBus?.emit('security.breached_password.api_failure', {
      meta: { userId: context?.userId, ip: context?.ip },
    });
    if ((config?.onApiFailure ?? 'block') === 'block') {
      return { breached: true, count: -1 };
    }
    return { breached: false, count: 0 };
  }

  // Parse response: each line is "SUFFIX:COUNT"
  for (const line of responseText.split('\n')) {
    const [lineSuffix, countStr] = line.trim().split(':');
    if (lineSuffix === suffix) {
      const count = parseInt(countStr, 10);
      const breached = count >= minCount;
      if (breached) {
        eventBus?.emit('security.breached_password.detected', {
          meta: { count, userId: context?.userId },
        });
      }
      return { breached, count };
    }
  }

  return { breached: false, count: 0 };
}
