/**
 * Game session access policy.
 *
 * Uses `definePolicyDispatch()` from `slingshot-entity` for extensible
 * session access control dispatched by `gameType`.
 *
 * Other plugins can register game-type-specific access handlers via
 * `registerGameSessionHandler()`.
 */
import type { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { definePolicyDispatch, registerEntityPolicy } from '@lastshotlabs/slingshot-entity';

/** Stable policy key — referenced in entity route configs. */
export const GAME_SESSION_POLICY_KEY = 'game:session:access';

/**
 * Create the default session access policy.
 *
 * Dispatches on `gameType` field. Default fallback allows access to
 * lobbies and denies access to in-progress sessions unless overridden
 * by a game-type-specific handler.
 */
export function createGameSessionPolicy() {
  return definePolicyDispatch({
    dispatch: input => {
      const record = input.record as Record<string, unknown> | null;
      return record ? (record.gameType as string) : undefined;
    },
    handlers: {},
    fallback: input => {
      const record = input.record as Record<string, unknown> | null;
      if (!record) return Promise.resolve({ allow: true });
      if (record.status === 'lobby') return Promise.resolve({ allow: true });
      return Promise.resolve({ allow: false });
    },
  });
}

/**
 * Register the game session policy on an app instance.
 *
 * Called during `setupMiddleware` in the plugin lifecycle.
 */
export function registerGameSessionPolicies(app: Hono<AppEnv>): void {
  registerEntityPolicy(app, GAME_SESSION_POLICY_KEY, createGameSessionPolicy());
}
