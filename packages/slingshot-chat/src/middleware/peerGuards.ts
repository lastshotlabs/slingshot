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
import { isPackageRegistered } from '@lastshotlabs/slingshot-core';
import type { PluginSetupContext } from '@lastshotlabs/slingshot-core';

type ChatPluginApp = PluginSetupContext['app'];

/**
 * Build the 503 guard for poll features.
 *
 * Checks if the request body contains a `poll` field. If so, verifies that
 * `slingshot-polls` is registered. Returns 503 before any side effects when
 * the package is absent.
 */
export function buildPollRequiredGuard(app: ChatPluginApp | Hono) {
  return async (c: Context, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      // No JSON body; skip poll check and continue
      await next();
      return;
    }

    if (body.poll) {
      if (!isPackageRegistered(app, 'slingshot-polls')) {
        throw new HTTPException(503, {
          message:
            'slingshot-polls is required for poll features but is not registered. ' +
            'Add createPollsPackage() to your app\'s `packages` array.',
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
 * so, verifies that `slingshot-assets` is registered. Returns 503 before
 * any side effects when the package is absent.
 */
export function buildAttachmentRequiredGuard(app: ChatPluginApp | Hono) {
  return async (c: Context, next: Next) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      // No JSON body; skip attachment check and continue
      await next();
      return;
    }

    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      if (!isPackageRegistered(app, 'slingshot-assets')) {
        throw new HTTPException(503, {
          message:
            'slingshot-assets is required for attachment features but is not registered. ' +
            'Add createAssetsPackage() to your app\'s `packages` array.',
        });
      }
    }

    await next();
  };
}
