import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HttpError, getActor } from '@lastshotlabs/slingshot-core';
import { getAuthRuntimeFromRequest } from '../runtime';

/**
 * Options for the step-up MFA middleware.
 */
export interface StepUpOptions {
  /**
   * Maximum age in seconds that a step-up MFA verification remains valid.
   * After this window the user must re-complete step-up even if they already
   * verified MFA earlier in the session.
   *
   * Default: `300` (5 minutes).
   *
   * @remarks
   * The `mfaVerifiedAt` timestamp stored in the session is a Unix timestamp in
   * **seconds** (not milliseconds). It is written by `POST /auth/step-up` as
   * `Math.floor(Date.now() / 1000)` and compared against
   * `Math.floor(Date.now() / 1000) - maxAge`. Values larger than a few hours are
   * inadvisable for high-privilege actions; prefer short windows (300–900 s) and
   * require re-verification.
   */
  maxAge?: number;
}

/**
 * Middleware that requires the requesting user to have recently completed step-up MFA.
 *
 * "Step-up" means the user successfully completed a second factor (TOTP, email OTP, WebAuthn,
 * or password re-verification) via `POST /auth/step-up` within the `maxAge` window. A
 * timestamp (`mfaVerifiedAt`, unix seconds) is stored in the session on step-up success.
 * This middleware reads that timestamp and enforces the recency constraint.
 *
 * Must run after the `identify` middleware (requires `sessionId` to be set on context).
 *
 * @param opts - Optional step-up configuration.
 * @param opts.maxAge - Maximum step-up age in seconds. Defaults to `300` (5 minutes).
 * @returns A Hono `MiddlewareHandler<AppEnv>`.
 *
 * @throws `HttpError(401, 'Authentication required')` — when there is no active session
 *   (`sessionId` is null, i.e., the user is not logged in at all).
 * @throws `HttpError(403, 'Step-up authentication required', 'STEP_UP_REQUIRED')` — when
 *   the session has no `mfaVerifiedAt` record (step-up was never completed).
 * @throws `HttpError(403, 'Step-up authentication expired', 'STEP_UP_REQUIRED')` — when
 *   `mfaVerifiedAt` exists but is older than `maxAge` seconds.
 *
 * @example
 * import { userAuth, requireStepUp } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * // Require fresh step-up (within 5 min) before executing a wire transfer
 * app.post('/transfer', userAuth, requireStepUp(), transferHandler);
 *
 * // Longer window for lower-risk sensitive actions
 * app.post('/export-data', userAuth, requireStepUp({ maxAge: 900 }), exportHandler);
 */
export const requireStepUp =
  (opts?: StepUpOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const sessionId = getActor(c).sessionId;
    if (!sessionId) {
      throw new HttpError(401, 'Authentication required');
    }

    const maxAge = opts?.maxAge ?? 300;
    const runtime = getAuthRuntimeFromRequest(c);
    const verifiedAt = await runtime.repos.session.getMfaVerifiedAt(sessionId);

    if (verifiedAt === null) {
      throw new HttpError(403, 'Step-up authentication required', 'STEP_UP_REQUIRED');
    }

    const now = Math.floor(Date.now() / 1000);
    if (now - verifiedAt > maxAge) {
      throw new HttpError(403, 'Step-up authentication expired', 'STEP_UP_REQUIRED');
    }

    await next();
  };
