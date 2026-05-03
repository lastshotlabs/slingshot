import type { MiddlewareHandler } from 'hono';
import type { EntityAdapter } from '@lastshotlabs/slingshot-core';
import { getActor, getActorTenantId } from '@lastshotlabs/slingshot-core';
import type { ModerationDecision, ModerationTarget } from '../types/config';
import type { CommunityPrincipal } from '../types/env';
import type { Report } from '../types/models';

type AutoModRuleRecord = {
  readonly tenantId?: string | null;
  readonly containerId?: string | null;
  readonly enabled?: boolean;
  readonly matcher?: unknown;
  readonly decision?: 'flag' | 'reject' | 'shadow-ban';
  readonly priority?: number;
  readonly name?: string;
};

type AutoModRuleAdapter = {
  list(input: { filter?: Record<string, unknown>; limit?: number }): Promise<{
    items: AutoModRuleRecord[];
  }>;
};

type MatcherRecord = {
  readonly type?: unknown;
  readonly keyword?: unknown;
  readonly keywords?: unknown;
  readonly words?: unknown;
  readonly value?: unknown;
  readonly pattern?: unknown;
  readonly flags?: unknown;
  readonly caseSensitive?: unknown;
};

function asRecord(value: unknown): MatcherRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as MatcherRecord)
    : null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function ruleMatches(rule: AutoModRuleRecord, bodyText: string): boolean {
  const matcher = asRecord(rule.matcher);
  if (!matcher) return false;
  const type = typeof matcher.type === 'string' ? matcher.type : '';

  if (type === 'keyword') {
    const keywords = [
      ...stringList(matcher.keywords),
      ...stringList(matcher.words),
      ...stringList(matcher.keyword),
      ...stringList(matcher.value),
    ];
    if (keywords.length === 0) return false;
    const caseSensitive = matcher.caseSensitive === true;
    const haystack = caseSensitive ? bodyText : bodyText.toLowerCase();
    return keywords.some(keyword => {
      const needle = caseSensitive ? keyword : keyword.toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    });
  }

  if (type === 'regex') {
    if (typeof matcher.pattern !== 'string' || matcher.pattern.length === 0) return false;
    const flags =
      typeof matcher.flags === 'string' ? matcher.flags.replace(/[^dgimsuvy]/g, '') : 'i';
    try {
      return new RegExp(matcher.pattern, flags).test(bodyText);
    } catch {
      // Invalid regex pattern; treat as non-match
      return false;
    }
  }

  return false;
}

function decisionRank(decision: ModerationDecision): number {
  if (decision === 'reject') return 2;
  if (decision === 'flag') return 1;
  return 0;
}

function strongestDecision(
  left: ModerationDecision,
  right: ModerationDecision,
): ModerationDecision {
  return decisionRank(right) > decisionRank(left) ? right : left;
}

function toModerationDecision(decision: AutoModRuleRecord['decision']): ModerationDecision {
  if (decision === 'reject') return 'reject';
  if (decision === 'flag' || decision === 'shadow-ban') return 'flag';
  return 'allow';
}

async function evaluateRules(args: {
  adapter?: AutoModRuleAdapter;
  tenantId?: string;
  containerId?: string;
  bodyText: string;
}): Promise<ModerationDecision> {
  if (!args.adapter || args.bodyText.length === 0) return 'allow';

  const result = await args.adapter.list({ filter: { enabled: true }, limit: 500 });
  const rules = result.items
    .filter(rule => rule.enabled !== false)
    .filter(rule => rule.tenantId == null || rule.tenantId === args.tenantId)
    .filter(rule => rule.containerId == null || rule.containerId === args.containerId)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));

  let decision: ModerationDecision = 'allow';
  for (const rule of rules) {
    if (ruleMatches(rule, args.bodyText)) {
      decision = strongestDecision(decision, toModerationDecision(rule.decision));
      if (decision === 'reject') return decision;
    }
  }
  return decision;
}

/**
 * Create a Hono middleware that runs auto-moderation on new content before it
 * is created.
 *
 * The middleware evaluates declarative `AutoModRule` rows and, when present,
 * also calls `deps.autoModerationHook` with a `ModerationTarget` derived from
 * the request body and request identity. The strongest decision wins:
 * - `'allow'`: passes through immediately — no report is created.
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
 * @param deps.autoModRuleAdapter - Optional AutoModRule adapter for keyword and
 *   regex rule evaluation.
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
  autoModRuleAdapter?: AutoModRuleAdapter;
  reportAdapter: EntityAdapter<Report, Record<string, unknown>, Record<string, unknown>>;
}): MiddlewareHandler {
  return async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return next();
    const principal = c.get('communityPrincipal') as CommunityPrincipal | undefined;
    const actor = getActor(c);
    const authorId = principal?.subject ?? actor.id;
    if (!authorId) return next();

    const bodyText =
      (typeof body.body === 'string' ? body.body : '') ||
      (typeof body.title === 'string' ? body.title : '');
    const tenantId = getActorTenantId(c) ?? undefined;
    const containerId = typeof body.containerId === 'string' ? body.containerId : undefined;

    const target: ModerationTarget = {
      type: c.req.path.includes('replies') ? 'reply' : 'thread',
      id: '', // pre-creation
      authorId,
      body: bodyText,
      tenantId,
    };

    const hookDecision = deps.autoModerationHook ? await deps.autoModerationHook(target) : 'allow';
    const ruleDecision = await evaluateRules({
      adapter: deps.autoModRuleAdapter,
      tenantId,
      containerId,
      bodyText,
    });
    const decision = strongestDecision(hookDecision, ruleDecision);
    if (decision === 'reject') {
      return c.json({ error: 'Content rejected by moderation' }, 403);
    }
    if (decision === 'flag') {
      // Create report, but allow content through
      await deps.reportAdapter.create({
        targetId: '', // filled post-creation via after-hook
        targetType: c.req.path.includes('replies') ? 'reply' : 'thread',
        containerId,
        reporterId: 'system:automod',
        reason: 'Flagged by auto-moderation',
        status: 'pending',
      });
    }
    await next();
  };
}
