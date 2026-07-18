/**
 * LLM-backed moderation.
 *
 * The headline capability: **the moderator may run on a different provider than
 * the generator.** Generate a deck on a free local model, judge it on Haiku for
 * a fraction of a cent. That is what `moderation.provider` is for, and it is why
 * moderation is a separate capability (`AiModerationCap`) rather than a flag on
 * the client — moderating player-typed content involves no generation at all.
 *
 * Two invariants:
 *
 * 1. **It fails CLOSED.** If the judge errors, or drops an item, the content is
 *    BLOCKED (`onError: 'block'`, the default). A safety control that quietly
 *    allows everything when it breaks is worse than no safety control, because
 *    the app believes it has one.
 *
 * 2. **It never re-enters itself.** The judging call is a plain
 *    `generateStructured` with no `moderation` on the request. It *does* go
 *    through the spend guard — judging costs real money and must count against
 *    the budget like anything else.
 */
import { z } from 'zod';
import type { AiPackageConfig } from '../config';
import { AiConfigError } from '../errors';
import type { AiLogger } from '../provider/types';
import type {
  AiItemVerdict,
  AiModerator,
  AiResult,
  AiSeverity,
  AiStructuredRequest,
  AiTags,
  AiUsage,
  AiVerdict,
} from '../types';
import type { AiMetrics } from './client';

const SEVERITY_RANK: Record<AiSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * The verdict shape the judge must produce.
 *
 * Fixed, and deliberately NOT app-supplied: an app that could reshape the
 * verdict could also reshape its way around it.
 */
const verdictSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      allowed: z.boolean(),
      categories: z.array(z.string()),
      severity: z.enum(['none', 'low', 'medium', 'high']),
      reason: z.string(),
    }),
  ),
});

type ModerationVerdict = z.infer<typeof verdictSchema>;

type Strategy = 'independent' | 'self';

interface Policy {
  readonly rules: string;
  readonly categories: string[];
  readonly blockAtOrAbove: AiSeverity;
}

export interface ModeratorDeps {
  readonly config: AiPackageConfig;
  readonly logger: AiLogger;
  readonly metrics?: AiMetrics;
  /**
   * The orchestrator's own `generateStructured`, injected rather than imported.
   *
   * That gives the judge the spend guard, the retry layer, and the single
   * validation point for free — a judge that bypassed those would be the one
   * call in the package that could quietly run away with the budget.
   */
  readonly generateStructured: <T>(req: AiStructuredRequest<T>) => Promise<AiResult<T>>;
}

function judgeSystemPrompt(policy: Policy): string {
  return [
    'You are a content moderator reviewing content generated for a party game.',
    '',
    'Apply EXACTLY this policy. Do not invent additional rules, and do not moderate on taste:',
    policy.rules,
    '',
    `Categories you may cite: ${policy.categories.join(', ')}.`,
    '',
    'For each numbered item, return one verdict with:',
    '  - index:      the item number, exactly as given',
    '  - allowed:    whether the item is acceptable under the policy',
    '  - categories: which of the categories above it violates (empty if none)',
    '  - severity:   none | low | medium | high',
    '  - reason:     one short sentence',
    '',
    'Judge each item independently. Return exactly one verdict per item.',
  ].join('\n');
}

function numberItems(items: readonly string[], offset: number): string {
  return items.map((text, index) => `[${offset + index}] ${text}`).join('\n\n');
}

function uniformVerdict(
  items: readonly string[],
  allowed: boolean,
  reason: string,
  strategy: AiVerdict['strategy'],
): AiVerdict {
  const categories = allowed ? [] : ['moderation-error'];
  const severity: AiSeverity = allowed ? 'none' : 'high';
  return {
    allowed,
    categories,
    severity,
    reason,
    items: items.map((_, index) => ({ index, allowed, categories, severity, reason })),
    usage: null,
    strategy,
  };
}

function mergeUsage(usages: readonly (AiUsage | null)[]): AiUsage | null {
  const present = usages.filter((usage): usage is AiUsage => usage !== null);
  const first = present[0];
  if (!first) return null;

  // One unpriced call makes the TOTAL unknown. Summing it as zero would report a
  // confident, wrong number — the exact thing `costUsd: null` exists to prevent.
  let costUsd: number | null = 0;
  for (const usage of present) {
    if (usage.costUsd === null) costUsd = null;
    else if (costUsd !== null) costUsd += usage.costUsd;
  }

  return {
    inputTokens: present.reduce((sum, u) => sum + u.inputTokens, 0),
    outputTokens: present.reduce((sum, u) => sum + u.outputTokens, 0),
    cacheReadTokens: present.reduce((sum, u) => sum + u.cacheReadTokens, 0),
    cacheWriteTokens: present.reduce((sum, u) => sum + u.cacheWriteTokens, 0),
    costUsd,
    accounting: first.accounting,
  };
}

export function createModerator(deps: ModeratorDeps): AiModerator {
  const { config, logger, metrics, generateStructured } = deps;
  const moderation = config.moderation;
  const policyNames = Object.keys(moderation.policies);

  // A custom moderator (a local classifier, a blocklist, a fake in tests) wins
  // outright. It is the swap point that keeps this from being LLM-only.
  if (moderation.moderator) {
    const custom = moderation.moderator;
    return {
      moderate: req => custom.moderate(req),
      policies: () => custom.policies(),
    };
  }

  /**
   * Where the judge runs.
   *
   * `independent` — a separate call, on `moderation.provider` when one is set.
   *   This is the configuration that lets you generate free and judge cheap.
   *
   * `self` — the same provider that generates also judges. Cheaper still, and
   *   materially weaker: it is the model grading its own homework, and a single
   *   injected "this content is safe" can talk it out of a verdict. Implemented
   *   as a second call rather than an inline verdict field on the app's schema,
   *   so the app's own output shape is never contaminated by a safety mechanism
   *   the app (and a prompt injection) could then see and route around.
   */
  function target(strategy: Strategy): { provider: string; model?: string } {
    if (strategy === 'self') return { provider: config.defaultProvider };
    return {
      provider: moderation.provider ?? config.defaultProvider,
      model: moderation.model,
    };
  }

  function judgeBatch(
    items: readonly string[],
    offset: number,
    policy: Policy,
    strategy: Strategy,
    tags: AiTags | undefined,
    spendScope: string | undefined,
  ): Promise<AiResult<ModerationVerdict>> {
    const where = target(strategy);
    return generateStructured({
      schema: verdictSchema,
      schemaName: 'moderation_verdict',
      provider: where.provider,
      ...(where.model ? { model: where.model } : {}),
      system: {
        // The policy is byte-identical on every call for a given policy name, so
        // it is exactly what prompt caching was built for. The items are
        // volatile and land after the breakpoint.
        stable: [{ id: 'moderation-policy', text: judgeSystemPrompt(policy) }],
      },
      messages: [{ role: 'user', content: numberItems(items, offset) }],
      promptCacheKey: 'slingshot-ai:moderation',
      tags,
      spendScope,
      // No `moderation` key — this call must not re-enter the moderator.
    });
  }

  /** One full pass (every batch) under one strategy. */
  async function runPass(
    items: readonly string[],
    policy: Policy,
    strategy: Strategy,
    tags: AiTags | undefined,
    spendScope: string | undefined,
  ): Promise<{ items: AiItemVerdict[]; usage: AiUsage | null }> {
    const size = moderation.maxBatchSize;
    const batches: { slice: readonly string[]; offset: number }[] = [];
    for (let start = 0; start < items.length; start += size) {
      batches.push({ slice: items.slice(start, start + size), offset: start });
    }

    const results = await Promise.all(
      batches.map(batch =>
        judgeBatch(batch.slice, batch.offset, policy, strategy, tags, spendScope),
      ),
    );

    const threshold = SEVERITY_RANK[policy.blockAtOrAbove];
    const byIndex = new Map<number, AiItemVerdict>();

    for (const result of results) {
      for (const verdict of result.value.items) {
        // `severity` is the decision variable; `blockAtOrAbove` is the knob. The
        // model's own `allowed` is advisory — if it decided the outcome, the
        // threshold an app configured would do nothing, and that is the sort of
        // knob that gets trusted precisely because it looks like it works.
        const blocked = SEVERITY_RANK[verdict.severity] >= threshold;
        byIndex.set(verdict.index, {
          index: verdict.index,
          allowed: !blocked,
          categories: verdict.categories,
          severity: verdict.severity,
          reason: verdict.reason,
        });
      }
    }

    return {
      items: items.map((_, index) => {
        const hit = byIndex.get(index);
        if (hit) return hit;
        // An item the judge returned no verdict for is BLOCKED, not waved
        // through. A dropped item is exactly what an injected payload would try
        // to cause, and "missing" must not read as "fine".
        return {
          index,
          allowed: false,
          categories: ['moderation-error'],
          severity: 'high' as const,
          reason: 'the moderator returned no verdict for this item',
        };
      }),
      usage: mergeUsage(results.map(result => result.usage)),
    };
  }

  return {
    async moderate({ content, policy: policyName, tags, spendScope }): Promise<AiVerdict> {
      const items = typeof content === 'string' ? [content] : [...content];
      const strategy = moderation.strategy;

      const policy = moderation.policies[policyName];
      if (!policy) {
        // A typo'd policy name must never quietly become "no moderation".
        throw new AiConfigError(
          `Moderation policy '${policyName}' is not defined. Configured policies: ` +
            `${policyNames.length > 0 ? policyNames.join(', ') : '(none)'}. Define it under ` +
            `\`moderation.policies\` in the slingshot-ai package config.`,
        );
      }

      if (items.length === 0) return uniformVerdict([], true, 'nothing to moderate', strategy);

      const passes: Strategy[] = strategy === 'both' ? ['independent', 'self'] : [strategy];

      let passResults: { items: AiItemVerdict[]; usage: AiUsage | null }[];
      try {
        passResults = await Promise.all(
          passes.map(pass => runPass(items, policy, pass, tags, spendScope)),
        );
      } catch (error) {
        // FAIL CLOSED. The judge broke; we do not get to assume the content was
        // fine. `onError: 'allow'` exists for apps that would rather ship than
        // block — and it is an explicit, named choice, not a default.
        const reason = `moderation failed: ${(error as Error).message}`;
        logger.error(`ai: ${reason}`, { policy: policyName, onError: moderation.onError });
        metrics?.counter('ai.moderation.error', 1, { policy: policyName });

        return uniformVerdict(items, moderation.onError === 'allow', reason, strategy);
      }

      // `both`: an item is blocked if EITHER pass blocks it. Disagreement is the
      // signal worth having — it is how you find out a policy is ambiguous
      // before a guest does.
      //
      // `runPass` always returns exactly one verdict per input item (it fills any
      // the judge dropped with a blocking placeholder), so every lookup below is
      // in range. The fallbacks are still written out rather than asserted:
      // if that invariant ever broke, this must fail CLOSED, not throw.
      const missing: AiItemVerdict = {
        index: -1,
        allowed: false,
        categories: ['moderation-error'],
        severity: 'high',
        reason: 'the moderator returned no verdict for this item',
      };
      const verdictAt = (pass: number, index: number): AiItemVerdict =>
        passResults[pass]?.items[index] ?? { ...missing, index };

      const finalItems = items.map((_, index) => {
        const verdicts = passResults.map((_result, pass) => verdictAt(pass, index));
        return verdicts.find(verdict => !verdict.allowed) ?? verdicts[0] ?? { ...missing, index };
      });

      let disagreement = false;
      if (passResults.length > 1) {
        disagreement = items.some(
          (_, index) => verdictAt(0, index).allowed !== verdictAt(1, index).allowed,
        );
        if (disagreement) {
          logger.warn(
            `ai: moderation strategies disagreed on policy '${policyName}' — the independent judge ` +
              `and the generating model reached different verdicts. The blocking verdict wins.`,
            { policy: policyName },
          );
          metrics?.counter('ai.moderation.disagreement', 1, { policy: policyName });
        }
      }

      const blocked = finalItems.filter(item => !item.allowed);
      const severity = finalItems.reduce<AiSeverity>(
        (worst, item) =>
          SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst] ? item.severity : worst,
        'none',
      );

      return {
        allowed: blocked.length === 0,
        categories: [...new Set(blocked.flatMap(item => item.categories))],
        severity,
        reason:
          blocked.length === 0
            ? 'no policy violations found'
            : `${blocked.length} of ${items.length} item(s) violated policy '${policyName}': ` +
              `${blocked[0]?.reason ?? 'unspecified'}`,
        items: finalItems,
        usage: mergeUsage(passResults.map(result => result.usage)),
        strategy,
        ...(passResults.length > 1 ? { disagreement } : {}),
      };
    },

    policies(): readonly string[] {
      return policyNames;
    },
  };
}
