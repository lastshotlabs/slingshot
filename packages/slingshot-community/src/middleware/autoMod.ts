import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import { getActorTenantId } from '@lastshotlabs/slingshot-core';
import type { ModerationDecision, ModerationTarget } from '../types/config';
import type { CommunityPrincipal } from '../types/env';
import type { Report } from '../types/models';

/**
 * Create a Hono middleware that runs auto-moderation on new content before it
 * is created.
 *
 * The middleware is a no-op when `deps.autoModerationHook` is not provided.
 * When the hook is present it is called before `next()` with a
 * `ModerationTarget` derived from the request body and the `communityPrincipal`
 * context value. The hook's `ModerationDecision` drives what happens next:
 * - `'approve'`: passes through immediately — no report is created.
 * - `'flag'`: creates a `Report` record via `deps.reportAdapter` with status
 *   `'pending'` and `reporterId: 'system:automod'`, then passes through so the
 *   content is still created.
 * - `'reject'`: returns `403 { error: 'Content rejected by moderation' }`
 *   without calling `next()`.
 *
 * The `type` field on `ModerationTarget` is inferred from the request path:
 * paths containing `'replies'` produce `type: 'reply'`; all others produce
 * `type: 'thread'`.
 *
 * @param deps.autoModerationHook - Optional async hook that receives a
 *   `ModerationTarget` and returns a `ModerationDecision`.
 * @param deps.reportAdapter - Entity adapter used to persist flagged-content
 *   reports.
 * @returns A Hono `MiddlewareHandler` suitable for use with `app.use()` or
 *   as route-level middleware.
 *
 * @remarks
 * The `targetId` on flagged reports is set to `''` at pre-creation time.
 * Callers should update it via an after-hook once the content record is created
 * and its ID is known.
 */
export function createAutoModMiddleware(deps: {
  autoModerationHook?: (
    content: ModerationTarget,
  ) => ModerationDecision | Promise<ModerationDecision>;
  reportAdapter: EntityAdapter<Report, Record<string, unknown>, Record<string, unknown>>;
}): MiddlewareHandler {
  return async (c, next) => {
    if (!deps.autoModerationHook) return next();
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return next();
    const principal = c.get('communityPrincipal') as CommunityPrincipal | undefined;
    if (!principal) return next();

    const bodyText =
      (typeof body.body === 'string' ? body.body : '') ||
      (typeof body.title === 'string' ? body.title : '');

    const decision = await deps.autoModerationHook({
      type: c.req.path.includes('replies') ? 'reply' : 'thread',
      id: '', // pre-creation
      authorId: principal.subject,
      body: bodyText,
      tenantId: getActorTenantId(c) ?? undefined,
    });
    if (decision === 'reject') {
      return c.json({ error: 'Content rejected by moderation' }, 403);
    }
    if (decision === 'flag') {
      // Create report, but allow content through
      await deps.reportAdapter.create({
        targetId: '', // filled post-creation via after-hook
        targetType: c.req.path.includes('replies') ? 'reply' : 'thread',
        reporterId: 'system:automod',
        reason: 'Flagged by auto-moderation',
        status: 'pending',
      });
    }
    await next();
  };
}
