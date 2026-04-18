import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export interface JobsConfig {
  /** Enable the job status endpoint. Default: false. */
  statusEndpoint?: boolean;
  /**
   * Auth protection for job endpoints.
   * - `"userAuth"` — requires authenticated user session (cookie/token).
   * - `"none"` — no auth (not recommended for production).
   * - `MiddlewareHandler[]` — custom middleware stack (e.g., `[userAuth, requireRole("admin")]`).
   *
   * Default: `"none"`. You must explicitly configure auth.
   */
  auth?: 'userAuth' | 'none' | MiddlewareHandler<AppEnv>[];
  /** Required roles for accessing job endpoints. Only works when auth includes userAuth. */
  roles?: string[];
  /** Whitelist of queue names exposed. Default: [] (nothing exposed). */
  allowedQueues?: string[];
  /**
   * Restrict job visibility to the authenticated user who created it.
   * Requires `auth: "userAuth"` so the framework can trust `authUserId`.
   * Default: false.
   */
  scopeToUser?: boolean;
  /**
   * Explicitly acknowledge that jobs endpoint is public in production.
   * Set to true only when auth is "none" and you understand the risk.
   * Without this, createApp throws in production when auth is "none".
   */
  unsafePublic?: boolean;
}
