/**
 * Cost computation.
 *
 * The load-bearing distinction in this file is `null` vs `0`:
 *
 *   - a NUMBER  → we know the price and this is the cost
 *   - `0`       → genuinely free (local inference)
 *   - `null`    → we do NOT know the price
 *
 * `null` must survive aggregation (as `unpricedCalls`) rather than being summed
 * as zero. A dashboard that quietly reports $0.00 because it couldn't price
 * half the calls is worse than one that says "I don't know".
 */
import type { AiUsage, ModelPricing } from '../types';
import type { AiProviderConfig } from '../config';
import type { ProviderCapabilities, ProviderUsage } from '../provider/types';

/**
 * Built-in price table, per million tokens.
 *
 * Config `providers[x].pricing` deep-merges OVER this, so a price change never
 * requires a package release.
 */
export const DEFAULT_PRICING: Readonly<Record<string, Readonly<Record<string, ModelPricing>>>> =
  Object.freeze({
    anthropic: Object.freeze({
      'claude-opus-4-8': {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
      'claude-opus-4-7': {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
      'claude-sonnet-5': {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
      'claude-haiku-4-5': {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1.25,
      },
    }),
  });

/** Resolve a model's price: config override → adapter table → built-in table → null. */
export function resolvePricing(options: {
  providerKind: string;
  model: string;
  providerConfig: AiProviderConfig | undefined;
  adapterPrice?: ModelPricing | null;
}): ModelPricing | null | 'free' {
  const configured = options.providerConfig?.pricing;
  if (configured === 'free') return 'free';
  if (configured && typeof configured === 'object') {
    const hit = configured[options.model];
    if (hit) return hit;
  }
  if (options.adapterPrice) return options.adapterPrice;
  return DEFAULT_PRICING[options.providerKind]?.[options.model] ?? null;
}

/** Turn raw token counts into an `AiUsage`, being honest about what we don't know. */
export function computeUsage(options: {
  usage: ProviderUsage;
  pricing: ModelPricing | null | 'free';
  capabilities: ProviderCapabilities;
}): AiUsage {
  const { usage, pricing, capabilities } = options;
  const base = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };

  if (pricing === 'free') {
    return { ...base, costUsd: 0, accounting: capabilities.usageAccounting };
  }
  if (!pricing || !capabilities.costAccounting) {
    // Unknown price, or a provider that doesn't account for cost at all.
    return { ...base, costUsd: null, accounting: capabilities.usageAccounting };
  }

  const cacheRead = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheWrite = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  const costUsd =
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000;

  return { ...base, costUsd, accounting: capabilities.usageAccounting };
}

/**
 * Worst-case cost of a call that has not happened yet.
 *
 * Used by the PRE-FLIGHT spend guard: assume every one of `maxTokens` output
 * tokens gets generated. A post-hoc check notices a runaway loop; a pre-flight
 * check stops it.
 */
export function estimateMaxCost(options: {
  inputTokens: number;
  maxTokens: number;
  pricing: ModelPricing | null | 'free';
}): number | null {
  const { pricing } = options;
  if (pricing === 'free') return 0;
  if (!pricing) return null;
  return (
    (options.inputTokens * pricing.inputPerMTok + options.maxTokens * pricing.outputPerMTok) /
    1_000_000
  );
}
