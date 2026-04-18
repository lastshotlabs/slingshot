/**
 * Optional-peer 503 guards for community.
 *
 * Fail loudly when a request uses an optional feature whose backing plugin
 * is absent. Must run BEFORE any persistence so no side effects occur on
 * a 503 path.
 *
 * Cold-start invariants:
 * - `slingshot-polls` / `slingshot-assets` absent + feature used → 503
 * - `slingshot-polls` / `slingshot-assets` absent + feature unused → CRUD works
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getContextOrNull } from '@lastshotlabs/slingshot-core';

/**
 * Build the 503 guard for poll features in community threads/replies.
 *
 * Checks if the request body contains a `poll` field. If so, verifies
 * that `slingshot-polls` is registered in pluginState.
 */
export function buildPollRequiredGuard(app: Hono<AppEnv>) {
  return async (c: Context, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      await next();
      return;
    }

    if (body.poll) {
      const ctx = getContextOrNull(app);
      const hasPolls = ctx?.pluginState.has('slingshot-polls') ?? false;
      if (!hasPolls) {
        throw new HTTPException(503, {
          message:
            'slingshot-polls plugin is required for poll features but is not registered. ' +
            'Add slingshot-polls to your app manifest or plugin list.',
        });
      }
    }

    await next();
  };
}

/**
 * Build the 503 guard for attachment features in community threads/replies.
 *
 * Checks if the request body contains a non-empty `attachments` array. If
 * so, verifies that `slingshot-assets` is registered in pluginState.
 */
export function buildAttachmentRequiredGuard(app: Hono<AppEnv>) {
  return async (c: Context, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      await next();
      return;
    }

    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      const ctx = getContextOrNull(app);
      const hasAssets = ctx?.pluginState.has('slingshot-assets') ?? false;
      if (!hasAssets) {
        throw new HTTPException(503, {
          message:
            'slingshot-assets plugin is required for attachment features but is not registered. ' +
            'Add slingshot-assets to your app manifest or plugin list.',
        });
      }
    }

    await next();
  };
}
