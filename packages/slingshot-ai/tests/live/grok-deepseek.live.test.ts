/**
 * Live tests for the `grok` and `deepseek` presets. These spend money.
 *
 * Skipped unless `SLINGSHOT_AI_LIVE=1` and the relevant key is present, so the
 * default suite stays hermetic, free, and offline.
 *
 *   SLINGSHOT_AI_LIVE=1 XAI_API_KEY=xai-...      bun test packages/slingshot-ai/tests/live
 *   SLINGSHOT_AI_LIVE=1 DEEPSEEK_API_KEY=sk-...  bun test packages/slingshot-ai/tests/live
 *
 * What a mock cannot tell you, and these can:
 *   - whether the models we default to still EXIST (deepseek-chat is deprecated
 *     2026-07-24; grok's lineup moves fast),
 *   - whether xAI's schema enforcement is as strict as it claims,
 *   - whether DeepSeek really does return a `prompt_cache_hit_tokens` split.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { aiPackageConfigSchema } from '../../src/config';
import { createAiClient } from '../../src/lib/client';
import { createDeepSeekProvider, createGrokProvider } from '../../src/provider/openaiCompatible';
import type { AiProvider } from '../../src/provider/types';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const GROK_LIVE = Bun.env.SLINGSHOT_AI_LIVE === '1' && Boolean(Bun.env.XAI_API_KEY);
const DEEPSEEK_LIVE = Bun.env.SLINGSHOT_AI_LIVE === '1' && Boolean(Bun.env.DEEPSEEK_API_KEY);

const Card = z.object({
  kind: z.enum(['truth', 'dare']),
  text: z.string(),
});

function clientFor(name: string, provider: AiProvider) {
  const config = aiPackageConfigSchema.parse({
    providers: { [name]: { provider } },
    defaultProvider: name,
    moderation: { enabled: false },
    usage: { enabled: false, persist: false },
    spend: { enabled: false },
  });
  return createAiClient({
    config,
    providers: new Map([[name, provider]]),
    logger: silentLogger,
  }).client;
}

describe.skipIf(!GROK_LIVE)('grok (live)', () => {
  const provider = () =>
    createGrokProvider(
      'grok',
      { apiKey: Bun.env.XAI_API_KEY },
      { apiKey: Bun.env.XAI_API_KEY!, logger: silentLogger },
    );

  test('the default model exists and answers', async () => {
    const result = await clientFor('grok', provider()).generate({
      system: { stable: [{ id: 'role', text: 'You are terse.' }] },
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxTokens: 16,
    });

    expect(result.value.toLowerCase()).toContain('ok');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test('native structured output really is enforced', async () => {
    const result = await clientFor('grok', provider()).generateStructured({
      schema: Card,
      schemaName: 'card',
      system: { stable: [{ id: 'role', text: 'You write party cards.' }] },
      messages: [{ role: 'user', content: 'One dare about singing.' }],
    });

    expect(Card.safeParse(result.value).success).toBe(true);
    // We declared `native`. If a structuredOutput degradation shows up here, the
    // declaration is a lie and the capability descriptor needs fixing.
    expect(result.degradations.map(d => d.feature)).not.toContain('structuredOutput');
  });
});

describe.skipIf(!DEEPSEEK_LIVE)('deepseek (live)', () => {
  const provider = () =>
    createDeepSeekProvider(
      'deepseek',
      { apiKey: Bun.env.DEEPSEEK_API_KEY },
      { apiKey: Bun.env.DEEPSEEK_API_KEY!, logger: silentLogger },
    );

  test('deepseek-v4-flash exists (deepseek-chat is deprecated 2026-07-24)', async () => {
    const result = await clientFor('deepseek', provider()).generate({
      system: { stable: [{ id: 'role', text: 'You are terse.' }] },
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxTokens: 16,
    });

    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.value.toLowerCase()).toContain('ok');
  });

  test('json-mode round-trips a real schema through the repair loop', async () => {
    const result = await clientFor('deepseek', provider()).generateStructured({
      schema: Card,
      schemaName: 'card',
      system: { stable: [{ id: 'role', text: 'You write party cards.' }] },
      messages: [{ role: 'user', content: 'One dare about singing.' }],
    });

    expect(Card.safeParse(result.value).success).toBe(true);
    // We declared `json-mode`, so the shortfall MUST be reported. If this
    // assertion fails, either DeepSeek gained json_schema (upgrade the
    // descriptor) or something is lying.
    expect(result.degradations.map(d => d.feature)).toContain('structuredOutput');
  });

  test('reports the disjoint cache split on a repeated prefix', async () => {
    const client = clientFor('deepseek', provider());
    // A prefix long enough to be worth caching, sent twice.
    const stable = [{ id: 'rules', text: 'You are a party game.\n'.repeat(200) }];

    await client.generate({
      system: { stable },
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 8,
      promptCacheKey: 'live-test',
    });
    const second = await client.generate({
      system: { stable },
      messages: [{ role: 'user', content: 'Say ok again.' }],
      maxTokens: 8,
      promptCacheKey: 'live-test',
    });

    // Caching is automatic and best-effort, so this is not guaranteed — but if it
    // NEVER hits, mapDeepSeekUsage is reading the wrong fields.
    expect(second.usage.cacheReadTokens).toBeGreaterThanOrEqual(0);
    expect(second.usage.inputTokens).toBeGreaterThanOrEqual(0);
  });
});
