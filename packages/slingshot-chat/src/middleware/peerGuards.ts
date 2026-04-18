/**
 * Optional-peer 503 guards for chat.
 *
 * Fail loudly when a request uses an optional feature whose backing plugin
 * is absent. Must run BEFORE any persistence so no side effects occur on
 * a 503 path.
 *
 * Cold-start invariants:
 * - `slingshot-polls` missing + poll payload → 503
 * - `slingshot-assets` missing + attachments  → 503
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getContext } from '@lastshotlabs/slingshot-core';
import type { PluginSetupContext } from '@lastshotlabs/slingshot-core';

type ChatPluginApp = PluginSetupContext['app'];

/**
 * Build the 503 guard for poll features.
 *
 * Checks if the request body contains a `poll` field. If so, verifies
 * that `slingshot-polls` is registered in pluginState. Returns 503 before
 * any side effects when the plugin is absent.
 */
export function buildPollRequiredGuard(app: ChatPluginApp | Hono) {
  return async (c: Context, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      await next();
      return;
    }

    if (body.poll) {
      const hasPolls = getContext(app).pluginState.has('slingshot-polls');
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
 * Build the 503 guard for attachment features.
 *
 * Checks if the request body contains a non-empty `attachments` array. If
 * so, verifies that `slingshot-assets` is registered in pluginState. Returns
 * 503 before any side effects when the plugin is absent.
 */
export function buildAttachmentRequiredGuard(app: ChatPluginApp | Hono) {
  return async (c: Context, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      await next();
      return;
    }

    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      const hasAssets = getContext(app).pluginState.has('slingshot-assets');
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
