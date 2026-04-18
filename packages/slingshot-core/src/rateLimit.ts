import { type ContextCarrier, resolveContext } from './context/contextAccess';
import type { FingerprintBuilder, RateLimitAdapter } from './coreContracts';

export type { FingerprintBuilder, RateLimitAdapter };

// ---------------------------------------------------------------------------
// RateLimitAdapter + FingerprintBuilder -- rate limiting contracts.
// ---------------------------------------------------------------------------

/**
 * Retrieve the `RateLimitAdapter` registered on a Slingshot app or context instance.
 *
 * The rate limit adapter tracks request counts per key within a rolling window.
 * The framework uses it for endpoint-level rate limiting middleware. The default
 * implementation is `createMemoryRateLimitAdapter()` (registered by `createApp()`).
 * The auth plugin may replace it with a distributed (Redis) implementation.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `RateLimitAdapter`.
 * @throws If no adapter has been registered (should never happen in a properly
 *   bootstrapped app — `createApp()` always registers the in-memory adapter as a
 *   baseline, and the auth plugin may replace it with a Redis-backed one).
 *
 * @remarks
 * A memory-based `RateLimitAdapter` is always registered by `createApp()` as the
 * default, so this function should never throw in a correctly bootstrapped Slingshot app.
 * The only way to reach the throw is to call `getRateLimitAdapter()` on a
 * `SlingshotContext` that was constructed manually (e.g., in a unit test) without going
 * through `createApp()`.
 *
 * @example
 * ```ts
 * import { getRateLimitAdapter, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const adapter = getRateLimitAdapter(getContext(app));
 * const exceeded = await adapter.trackAttempt(`login:${ip}`, { windowMs: 60_000, max: 5 });
 * ```
 */
export function getRateLimitAdapter(input: ContextCarrier): RateLimitAdapter {
  const adapter = resolveContext(input).rateLimitAdapter;
  if (adapter === null) {
    throw new Error('No RateLimitAdapter registered for this app instance.');
  }
  return adapter;
}

/**
 * Retrieve the `FingerprintBuilder` registered on a Slingshot app or context instance.
 *
 * The fingerprint builder produces a short hash of stable request headers (User-Agent,
 * Accept-Language, Accept-Encoding) to assist bot detection and rate limiting when
 * no authenticated user is present. The default is `createDefaultFingerprintBuilder()`.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns The registered `FingerprintBuilder`.
 * @throws If no fingerprint builder has been registered. Like `getRateLimitAdapter`,
 *   this should never throw in a correctly bootstrapped Slingshot app — `createApp()`
 *   always registers the default fingerprint builder.
 *
 * @remarks
 * The default fingerprint builder hashes stable, non-identifying request headers
 * (User-Agent, Accept-Language, Accept-Encoding) to produce a short opaque token
 * suitable for rate limiting unauthenticated traffic. It does NOT uniquely identify
 * individual users — it groups requests by device/browser profile. The auth plugin may
 * replace it with a more sophisticated implementation that incorporates IP address or
 * TLS fingerprint signals.
 *
 * @example
 * ```ts
 * import { getFingerprintBuilder, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const builder = getFingerprintBuilder(getContext(app));
 * const fingerprint = await builder.buildFingerprint(c.req.raw);
 * ```
 */
export function getFingerprintBuilder(input: ContextCarrier): FingerprintBuilder {
  const builder = resolveContext(input).fingerprintBuilder;
  if (builder === null) {
    throw new Error('No FingerprintBuilder registered for this app instance.');
  }
  return builder;
}
