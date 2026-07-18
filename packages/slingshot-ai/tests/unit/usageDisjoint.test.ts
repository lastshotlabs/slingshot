/**
 * `ProviderUsage`'s four token counts are DISJOINT — and cost depends on it.
 *
 * `computeUsage()` bills them additively:
 *
 *     cost = inputTokens*in + outputTokens*out + cacheReadTokens*read + ...
 *
 * so `inputTokens` must be the portion billed at the FULL rate, i.e. excluding
 * cache reads. Anthropic reports that natively (`input_tokens` excludes
 * `cache_read_input_tokens`), which is why the formula was written this way —
 * but the OpenAI family reports `prompt_tokens` as a TOTAL with `cached_tokens`
 * as a SUBSET of it, and the adapter used to pass that total straight through.
 * Every cached token was therefore billed twice: once at the input rate and
 * again at the cache-read rate.
 *
 * These tests pin the invariant for every adapter in the family.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AiProviderConfig } from '../../src/config';
import { computeUsage } from '../../src/lib/pricing';
import {
  createDeepSeekProvider,
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
} from '../../src/provider/openaiCompatible';
import type { NormalizedRequest } from '../../src/provider/types';
import { startMockOpenAi } from '../support/mockServers';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const openaiMock = startMockOpenAi();
const deepseekMock = startMockOpenAi({ usageDialect: 'deepseek' });
afterAll(() => {
  openaiMock.stop();
  deepseekMock.stop();
});

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

describe('inputTokens excludes cached tokens, for every adapter in the family', () => {
  // Both mocks describe the SAME call: 13 input tokens, 4 of which were cached.
  // They just say it in different dialects.
  const EXPECTED = { inputTokens: 9, cacheReadTokens: 4, outputTokens: 9 };

  test('openai-compatible subtracts the cached subset from prompt_tokens', async () => {
    const provider = createOpenAiCompatibleProvider('local', config(openaiMock.url), {
      apiKey: null,
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    expect(usage).toMatchObject(EXPECTED);
    // The bug: prompt_tokens is 13, and reporting it here charged the 4 cached
    // tokens at the full input rate AND again at the cache-read rate.
    expect(usage.inputTokens).not.toBe(13);
  });

  test('openai preset does the same', async () => {
    const provider = createOpenAiProvider('openai', config(openaiMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    expect(usage).toMatchObject(EXPECTED);
  });

  test('deepseek reads its disjoint top-level split and lands on the same numbers', async () => {
    const provider = createDeepSeekProvider('deepseek', config(deepseekMock.url), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    const { usage } = await provider.generate(request);

    // Same call, same truth — arrived at from `prompt_cache_miss_tokens` rather
    // than by subtraction. The two dialects converge, which is the point.
    expect(usage).toMatchObject(EXPECTED);
  });
});

describe('the cost consequence', () => {
  const capabilities = {
    structuredOutput: 'json-mode',
    promptCaching: 'automatic',
    streaming: true,
    thinking: 'none',
    effort: false,
    usageAccounting: 'full',
    costAccounting: true,
    refusalSignal: false,
    imageInput: false,
    toolUse: false,
    maxOutputTokens: 4096,
  } as const;

  test('a cached token is billed once, at the cache rate — not twice', () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0 };

    const correct = computeUsage({
      usage: { inputTokens: 9, outputTokens: 0, cacheReadTokens: 4, cacheWriteTokens: 0 },
      pricing,
      capabilities,
    });
    // 9 uncached @ $1/MTok + 4 cached @ $0 = 9 units.
    expect(correct.costUsd).toBeCloseTo(9 / 1_000_000, 12);

    // What the old mapper produced: prompt_tokens (13) passed through as
    // inputTokens, with cacheReadTokens ALSO reported. The 4 cached tokens get
    // charged at the full rate on top of being counted as cache reads.
    const doubleCounted = computeUsage({
      usage: { inputTokens: 13, outputTokens: 0, cacheReadTokens: 4, cacheWriteTokens: 0 },
      pricing,
      capabilities,
    });
    expect(doubleCounted.costUsd).toBeCloseTo(13 / 1_000_000, 12);
    expect(doubleCounted.costUsd!).toBeGreaterThan(correct.costUsd!);
  });

  test('on DeepSeek the error is ~50x, because that is the gap between its cache-hit and cache-miss rates', () => {
    // deepseek-v4-flash, verified 2026-07-13.
    const pricing = { inputPerMTok: 0.14, outputPerMTok: 0.28, cacheReadPerMTok: 0.0028 };
    const cached = 1_000_000;

    const correct = computeUsage({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: cached, cacheWriteTokens: 0 },
      pricing,
      capabilities,
    });
    // A million cached tokens: $0.0028.
    expect(correct.costUsd).toBeCloseTo(0.0028, 6);

    // Read the cache split wrong (cached → 0, all of it billed as fresh input)
    // and the same call reports $0.14 — on the provider chosen precisely because
    // it is cheap.
    const misread = computeUsage({
      usage: { inputTokens: cached, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pricing,
      capabilities,
    });
    expect(misread.costUsd).toBeCloseTo(0.14, 6);
    expect(misread.costUsd! / correct.costUsd!).toBeCloseTo(50, 0);
  });
});
