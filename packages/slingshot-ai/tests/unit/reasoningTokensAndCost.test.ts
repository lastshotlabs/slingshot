/**
 * Reasoning tokens, vendor-reported cost, and tiered pricing.
 *
 * Every payload in this file was CAPTURED FROM THE LIVE API on 2026-07-13, not
 * invented. That matters: the bug being pinned here is that three vendors use the
 * SAME field name, `completion_tokens`, with TWO OPPOSITE meanings, and a fixture
 * we made up would only have proved our own assumption back to us.
 *
 *   - **xAI**      `completion_tokens` EXCLUDES reasoning.
 *                  `prompt 215 + completion 5 + reasoning 41 = total 261`.
 *   - **DeepSeek** `completion_tokens` INCLUDES reasoning.
 *                  `completion 45, of which reasoning 39`; `prompt 18 + 45 = 63`.
 *   - **OpenAI**   `completion_tokens` INCLUDES reasoning (as DeepSeek).
 *                  `prompt 8 + completion 40 (all reasoning) = total 48`.
 *
 * Reasoning is billed at the OUTPUT rate by all of them. So on xAI, billing
 * `completion_tokens` charged 5 of the 46 output tokens actually produced — an
 * ~89% undercount that the pre-flight spend guard could not see. Adding reasoning
 * on DeepSeek or OpenAI would double-count it just as badly in the other
 * direction. There is no global rule; only a per-vendor one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AiProviderConfig } from '../../src/config';
import { computeUsage, estimateMaxCost, selectTier } from '../../src/lib/pricing';
import {
  createDeepSeekProvider,
  createGrokProvider,
  createOpenAiProvider,
} from '../../src/provider/openaiCompatible';
import type {
  ModelPricing,
  NormalizedRequest,
  ProviderCapabilities,
} from '../../src/provider/types';
import { startMockOpenAi } from '../support/mockServers';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const request: NormalizedRequest = {
  model: 'mock-model',
  system: [{ text: 'fixture', cache: false }],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 128,
  timeoutMs: 10_000,
};

function config(url: string, extra: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return { baseUrl: url, defaultModel: 'mock-model', ...extra };
}

/**
 * A full, honest capability descriptor — not a partial cast. `computeUsage` only
 * reads two fields, but asserting a partial into the type is how a descriptor
 * quietly loses a field it later needs.
 */
const PRICED_CAPS: ProviderCapabilities = {
  structuredOutput: 'native',
  promptCaching: 'automatic',
  streaming: true,
  thinking: 'adaptive',
  effort: true,
  usageAccounting: 'full',
  costAccounting: true,
  refusalSignal: false,
  toolUse: true,
  maxOutputTokens: 8192,
};

// ---------------------------------------------------------------------------
// Real captured payloads
// ---------------------------------------------------------------------------

/** xAI grok-4.5, live. 215 + 5 + 41 = 261 — reasoning is ADDITIVE to the total. */
const GROK_USAGE = {
  prompt_tokens: 215,
  completion_tokens: 5,
  total_tokens: 261,
  prompt_tokens_details: { cached_tokens: 128 },
  completion_tokens_details: { reasoning_tokens: 41 },
  cost_in_usd_ticks: 5_140_000,
};

/** DeepSeek deepseek-v4-flash, live. completion 45 CONTAINS reasoning 39. */
const DEEPSEEK_USAGE = {
  prompt_tokens: 18,
  completion_tokens: 45,
  total_tokens: 63,
  completion_tokens_details: { reasoning_tokens: 39 },
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 18,
};

/** OpenAI gpt-5-mini, live. The whole 40-token budget went to reasoning. */
const OPENAI_USAGE = {
  prompt_tokens: 8,
  completion_tokens: 40,
  total_tokens: 48,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 40 },
};

const grokMock = startMockOpenAi({ usage: GROK_USAGE });
const deepseekMock = startMockOpenAi({ usage: DEEPSEEK_USAGE });
const openaiMock = startMockOpenAi({ usage: OPENAI_USAGE });
afterAll(() => {
  grokMock.stop();
  deepseekMock.stop();
  openaiMock.stop();
});

describe('reasoning tokens are billed as output, per each vendor’s own convention', () => {
  test('grok ADDS reasoning to completion_tokens (they are disjoint on the wire)', async () => {
    const provider = createGrokProvider('grok', config(grokMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    // 5 visible + 41 reasoned = 46 output tokens actually produced and billed.
    expect(usage.outputTokens).toBe(46);
    // The bug: this is what we used to report, and it is 11% of the truth.
    expect(usage.outputTokens).not.toBe(5);
    // Input still excludes the cached subset (the F5 invariant, still holding).
    expect(usage.inputTokens).toBe(87);
    expect(usage.cacheReadTokens).toBe(128);
  });

  test('deepseek does NOT add reasoning — completion_tokens already contains it', async () => {
    const provider = createDeepSeekProvider('deepseek', config(deepseekMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    // 45, NOT 45 + 39. Adding would double-bill the 39 reasoning tokens.
    expect(usage.outputTokens).toBe(45);
    expect(usage.outputTokens).not.toBe(84);
  });

  test('openai does NOT add reasoning either — same convention as deepseek', async () => {
    const provider = createOpenAiProvider('openai', config(openaiMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    expect(usage.outputTokens).toBe(40);
    expect(usage.outputTokens).not.toBe(80);
  });
});

describe('vendor-reported cost beats the price table', () => {
  const caps = PRICED_CAPS;

  test('grok surfaces cost_in_usd_ticks as reportedCostUsd (1 tick = 1e-10 USD)', async () => {
    const provider = createGrokProvider('grok', config(grokMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    // 5,140,000 ticks × 1e-10 = $0.000514.
    expect(usage.reportedCostUsd).toBeCloseTo(0.000514, 10);
  });

  test('the tick unit reproduces the vendor figure from first principles', () => {
    // Independent check of the derivation: price the captured token counts with
    // grok-4.5's published rates ($2 in / $6 out) and the DERIVED $0.50 cached
    // rate, and it must land exactly on the vendor's own reported cost.
    //   uncached input 87 × $2   = 174
    //   output         46 × $6   = 276   ← only correct because reasoning is counted
    //   cached input  128 × $0.50 =  64
    //                              ---
    //                              514 / 1e6 = $0.000514  ✓ == 5,140,000 ticks
    const fromTable = (87 * 2 + 46 * 6 + 128 * 0.5) / 1_000_000;
    expect(fromTable).toBeCloseTo(5_140_000 * 1e-10, 12);
  });

  test('computeUsage prefers the reported cost over the table', () => {
    const usage = {
      inputTokens: 87,
      outputTokens: 46,
      cacheReadTokens: 128,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.000514,
    };
    // A deliberately WRONG table — if it were consulted, cost would be huge.
    const pricing: ModelPricing = { inputPerMTok: 999, outputPerMTok: 999 };

    expect(computeUsage({ usage, pricing, capabilities: caps }).costUsd).toBeCloseTo(0.000514, 10);
  });

  test('but `free` still wins — a local deployment costs nothing regardless', () => {
    const usage = {
      inputTokens: 87,
      outputTokens: 46,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.5,
    };
    expect(computeUsage({ usage, pricing: 'free', capabilities: caps }).costUsd).toBe(0);
  });

  test('with no reported cost, the table is used (deepseek reports none)', () => {
    const usage = { inputTokens: 18, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const pricing: ModelPricing = { inputPerMTok: 0.14, outputPerMTok: 0.28 };
    const cost = computeUsage({ usage, pricing, capabilities: caps }).costUsd;

    expect(cost).toBeCloseTo((18 * 0.14 + 45 * 0.28) / 1_000_000, 12);
  });
});

describe('grok cached input is priced, not billed at the full input rate', () => {
  const caps = PRICED_CAPS;

  test('grok-4.3 cached tokens cost $0.20/MTok, not $1.25', () => {
    const provider = createGrokProvider('grok', config(grokMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const pricing = provider.priceFor!('grok-4.3')!;

    // Derived exactly from the vendor's own ticks, and matching xAI's console.
    expect(pricing.cacheReadPerMTok).toBe(0.2);

    // Before the fix, `cacheReadPerMTok` was ABSENT and computeUsage fell back to
    // `inputPerMTok` — a 6.25× overcharge on every cached token.
    //
    // NOTE 100K, deliberately UNDER the 200K breakpoint: at 1M cached tokens the
    // context tier would (correctly) kick in and charge the $0.40 rate instead.
    // The first draft of this test used 1M and failed for exactly that reason,
    // which is a decent sign the tier logic is doing its job.
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
    };
    const cost = computeUsage({ usage, pricing, capabilities: caps }).costUsd;

    expect(cost).toBeCloseTo((100_000 * 0.2) / 1_000_000, 10); // $0.02
    // What the old fallback-to-input-rate behaviour would have charged.
    expect(cost).not.toBeCloseTo((100_000 * 1.25) / 1_000_000, 6);
  });

  test('grok-4.5 cached tokens cost $0.50/MTok', () => {
    const provider = createGrokProvider('grok', config(grokMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    expect(provider.priceFor!('grok-4.5')!.cacheReadPerMTok).toBe(0.5);
  });

  test('grok-4.3 is the default model, not the coding-grade 4.5', () => {
    const provider = createGrokProvider(
      'grok',
      { baseUrl: grokMock.url },
      { apiKey: 'sk-mock', logger: silentLogger },
    );
    expect(provider.defaultModel).toBe('grok-4.3');
  });
});

describe('context-tier pricing (xAI doubles above a 200K-token prompt)', () => {
  const tiered: ModelPricing = {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextTier: {
      aboveInputTokens: 200_000,
      inputPerMTok: 2.5,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.4,
    },
  };

  test('below the breakpoint, the base rates apply', () => {
    expect(selectTier(tiered, 199_999).inputPerMTok).toBe(1.25);
  });

  test('above it, the doubled rates apply', () => {
    expect(selectTier(tiered, 200_001).outputPerMTok).toBe(5);
    expect(selectTier(tiered, 200_001).cacheReadPerMTok).toBe(0.4);
  });

  test('the PRE-FLIGHT estimate uses the tier — under-estimating is the dangerous way to be wrong', () => {
    const big = estimateMaxCost({ inputTokens: 250_000, maxTokens: 1_000, pricing: tiered });
    const flat = (250_000 * 1.25 + 1_000 * 2.5) / 1_000_000;

    // A flat table would have told the spend guard this call costs HALF what it
    // does, and the guard would have let it through.
    expect(big).toBeCloseTo((250_000 * 2.5 + 1_000 * 5) / 1_000_000, 10);
    expect(big).toBeGreaterThan(flat);
  });
});
