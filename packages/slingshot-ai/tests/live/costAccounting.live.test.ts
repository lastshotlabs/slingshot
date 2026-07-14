/**
 * The cost path, against the real APIs. Spends a fraction of a cent.
 *
 * Every mock in this package encodes an assumption about what a vendor does. These
 * tests are the only thing that can tell us the assumption was wrong — and it has
 * been, repeatedly:
 *
 *   - xAI's `completion_tokens` EXCLUDES reasoning; everyone else's includes it.
 *   - xAI publishes no cached-input rate anywhere, yet bills one.
 *   - OpenAI 400s on `max_tokens` for every model it currently ships.
 *
 * None of that is in any doc we could have read. Run these when a model is
 * swapped, a preset is added, or a price is touched:
 *
 *   SLINGSHOT_AI_LIVE=1 XAI_API_KEY=... DEEPSEEK_API_KEY=... OPENAI_API_KEY=... \
 *     bun test packages/slingshot-ai/tests/live
 */
import { describe, expect, test } from 'bun:test';
import {
  createDeepSeekProvider,
  createGrokProvider,
  createOpenAiProvider,
} from '../../src/provider/openaiCompatible';
import type { NormalizedRequest } from '../../src/provider/types';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The raw vendor `usage` block. Typed loosely on purpose — it is the thing under test. */
interface RawUsage {
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  cost_in_usd_ticks?: number;
}
const rawUsage = (result: { raw: unknown }): RawUsage =>
  ((result.raw as { usage?: RawUsage })?.usage ?? {}) as RawUsage;
const LIVE = Bun.env.SLINGSHOT_AI_LIVE === '1';

function request(extra: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: '',
    system: [{ text: 'You are terse.', cache: false }],
    messages: [{ role: 'user', content: 'Reply with only the word OK.' }],
    maxTokens: 400,
    timeoutMs: 30_000,
    ...extra,
  };
}

describe.skipIf(!LIVE || !Bun.env.XAI_API_KEY)('grok, live', () => {
  const grok = () =>
    createGrokProvider(
      'grok',
      { defaultModel: 'grok-4.3' },
      { apiKey: Bun.env.XAI_API_KEY!, logger: silentLogger },
    );

  test('reasoning tokens are counted into outputTokens, and cost is the vendor’s own', async () => {
    const result = await grok().generate(request({ model: 'grok-4.3' }));

    // The whole point: xAI reasons on every call, and reasoning is billed. If
    // `outputTokens` ever equals the raw `completion_tokens` again, the ~89%
    // undercount is back.
    const raw = rawUsage(result);
    const completion = raw.completion_tokens ?? 0;
    const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? 0;

    expect(reasoning).toBeGreaterThan(0); // it always reasons; that's the premise
    expect(result.usage.outputTokens).toBe(completion + reasoning);

    // And the vendor tells us what it charged. 1 tick = 1e-10 USD.
    expect(result.usage.reportedCostUsd).toBeGreaterThan(0);
    expect(result.usage.reportedCostUsd).toBeCloseTo((raw.cost_in_usd_ticks ?? 0) * 1e-10, 12);
  });

  test('the derived cached rate reproduces the vendor’s reported cost', async () => {
    // Price the returned token counts with our table and check it lands on xAI's
    // own figure. This is the assertion that would have caught the missing cached
    // rate (a 6.25× overcharge) and the uncounted reasoning tokens — together.
    const provider = grok();
    const result = await provider.generate(request({ model: 'grok-4.3' }));
    const p = provider.priceFor!('grok-4.3')!;
    const u = result.usage;

    const fromTable =
      (u.inputTokens * p.inputPerMTok +
        u.outputTokens * p.outputPerMTok +
        u.cacheReadTokens * (p.cacheReadPerMTok ?? p.inputPerMTok)) /
      1_000_000;

    expect(fromTable).toBeCloseTo(u.reportedCostUsd!, 9);
  });
});

describe.skipIf(!LIVE || !Bun.env.DEEPSEEK_API_KEY)('deepseek, live', () => {
  const deepseek = () =>
    createDeepSeekProvider(
      'deepseek',
      { defaultModel: 'deepseek-v4-flash' },
      { apiKey: Bun.env.DEEPSEEK_API_KEY!, logger: silentLogger },
    );

  test('thinking: false really does disable reasoning (it defaults to ON)', async () => {
    const off = await deepseek().generate(request({ model: 'deepseek-v4-flash', thinking: false }));
    const on = await deepseek().generate(request({ model: 'deepseek-v4-flash', thinking: true }));

    const reasoningOf = (r: { raw: unknown }) =>
      rawUsage(r).completion_tokens_details?.reasoning_tokens ?? 0;

    // If the flag were dropped (as it was — the adapter sent no thinking param at
    // all), BOTH of these would reason, and every call would quietly pay for it.
    expect(reasoningOf(off)).toBe(0);
    expect(reasoningOf(on)).toBeGreaterThan(0);
    expect(off.usage.outputTokens).toBeLessThan(on.usage.outputTokens);
  });

  test('completion_tokens INCLUDES reasoning — do not add it again', async () => {
    const result = await deepseek().generate(
      request({ model: 'deepseek-v4-flash', thinking: true }),
    );
    const raw = rawUsage(result);

    // The mirror image of the xAI bug: here, adding reasoning double-bills it.
    expect(result.usage.outputTokens).toBe(raw.completion_tokens ?? 0);
    expect(raw.completion_tokens_details?.reasoning_tokens ?? 0).toBeGreaterThan(0);
  });
});

describe.skipIf(!LIVE || !Bun.env.OPENAI_API_KEY)('openai, live', () => {
  test('max_completion_tokens works where max_tokens 400s', async () => {
    const provider = createOpenAiProvider(
      'openai',
      { defaultModel: 'gpt-5.4-nano' },
      { apiKey: Bun.env.OPENAI_API_KEY!, logger: silentLogger },
    );

    // The preset used to send `max_tokens`, which is a hard 400 on every model
    // OpenAI currently ships. If this call succeeds, the rename is handled.
    const result = await provider.generate(request({ model: 'gpt-5.4-nano' }));

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.stopReason).toBe('end');
  });
});
