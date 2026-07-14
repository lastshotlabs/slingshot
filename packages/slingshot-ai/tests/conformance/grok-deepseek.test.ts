/**
 * The `grok` and `deepseek` presets.
 *
 * Both are the `openaiCompatible` transport with a baseUrl, a capability
 * descriptor, and a price table — which is the claim the provider seam makes, so
 * these tests are as much a test of the seam as of the two vendors.
 *
 * Fully hermetic: a local `Bun.serve` speaking each vendor's real usage dialect.
 * No key, no network, no cost.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type AiProviderConfig, aiPackageConfigSchema } from '../../src/config';
import { AiConfigError } from '../../src/errors';
import { createAiClient } from '../../src/lib/client';
import { createDeepSeekProvider, createGrokProvider } from '../../src/provider/openaiCompatible';
import type { NormalizedRequest } from '../../src/provider/types';
import { runProviderConformanceSuite } from '../../src/testing';
import { startMockOpenAi } from '../support/mockServers';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const grokMock = startMockOpenAi();
const deepseekMock = startMockOpenAi({ usageDialect: 'deepseek' });
afterAll(() => {
  grokMock.stop();
  deepseekMock.stop();
});

function grok(config: Partial<AiProviderConfig> = {}, server = grokMock) {
  return createGrokProvider(
    'grok',
    { baseUrl: server.url, ...config },
    { apiKey: 'xai-mock', logger: silentLogger },
  );
}

function deepseek(config: Partial<AiProviderConfig> = {}, server = deepseekMock) {
  return createDeepSeekProvider(
    'deepseek',
    { baseUrl: server.url, ...config },
    { apiKey: 'sk-mock', logger: silentLogger },
  );
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'mock-model',
    system: [{ text: 'You are a fixture.', cache: false }],
    messages: [{ role: 'user', content: 'Say hello.' }],
    maxTokens: 256,
    timeoutMs: 10_000,
    ...overrides,
  };
}

// The contract every adapter must satisfy — same suite as anthropic + openai.
runProviderConformanceSuite('grok', () => grok());
runProviderConformanceSuite('deepseek', () => deepseek());

// ---------------------------------------------------------------------------
// grok
// ---------------------------------------------------------------------------

describe('grok preset', () => {
  test('declares native schema enforcement and automatic caching', () => {
    const { capabilities } = grok();

    // xAI: "when using supported schema features, the response is guaranteed to
    // match your schema."
    expect(capabilities.structuredOutput).toBe('native');
    // Automatic, not explicit: there is no breakpoint to place, so there is also
    // no promptCacheMinTokens and nothing for the orchestrator to degrade.
    expect(capabilities.promptCaching).toBe('automatic');
    expect(capabilities.promptCacheMinTokens).toBeUndefined();
    expect(capabilities.costAccounting).toBe(true);
  });

  test('defaults to grok-4.5 and prices the lineup; unknown models price null', () => {
    const provider = grok();

    expect(provider.defaultModel).toBe('grok-4.5');
    expect(provider.priceFor!('grok-4.5')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 6 });
    expect(provider.priceFor!('grok-4.3')).toMatchObject({
      inputPerMTok: 1.25,
      outputPerMTok: 2.5,
    });
    expect(provider.priceFor!('grok-does-not-exist')).toBeNull();
  });

  test('sends promptCacheKey as x-grok-conv-id so the request routes to the cached prefix', async () => {
    await grok().generate(request({ promptCacheKey: 'hotseat:spicy-v1' }));

    expect(grokMock.headers.at(-1)!['x-grok-conv-id']).toBe('hotseat:spicy-v1');
  });

  test('omits the header entirely when there is no cache key', async () => {
    await grok().generate(request());

    expect(grokMock.headers.at(-1)).not.toHaveProperty('x-grok-conv-id');
  });

  test('requires an API key', () => {
    expect(() => createGrokProvider('grok', {}, { apiKey: null, logger: silentLogger })).toThrow(
      AiConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// deepseek
// ---------------------------------------------------------------------------

describe('deepseek preset', () => {
  test('declares json-mode HONESTLY — it has no json_schema, and saying so is the point', () => {
    const { capabilities } = deepseek();

    // DeepSeek supports `response_format: {type: 'json_object'}` only. Declaring
    // `native` would have the orchestrator trust a schema guarantee that does not
    // exist, and skip the repair loop that is the actual safety net.
    expect(capabilities.structuredOutput).toBe('json-mode');
    expect(capabilities.promptCaching).toBe('automatic');
    expect(capabilities.costAccounting).toBe(true);
  });

  test('defaults to deepseek-v4-flash, NOT the deprecated deepseek-chat', () => {
    // `deepseek-chat` / `deepseek-reasoner` are deprecated 2026-07-24. Defaulting
    // to either would be a time bomb with a known fuse length.
    expect(deepseek().defaultModel).toBe('deepseek-v4-flash');
  });

  test('prices v4-flash and v4-pro, including the 50x-cheaper cache-hit rate', () => {
    const provider = deepseek();

    expect(provider.priceFor!('deepseek-v4-flash')).toMatchObject({
      inputPerMTok: 0.14,
      outputPerMTok: 0.28,
      cacheReadPerMTok: 0.0028,
    });
    expect(provider.priceFor!('deepseek-v4-pro')).toMatchObject({
      inputPerMTok: 0.435,
      outputPerMTok: 0.87,
    });
    expect(provider.priceFor!('deepseek-chat')).toBeNull();
  });

  test('reads the DISJOINT top-level cache split, not the OpenAI nesting', async () => {
    const result = await deepseek().generate(request());

    // The mock sends prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 9,
    // and NO prompt_tokens_details. The generic mapper would read cached=0 and
    // bill all 13 at the cache-MISS rate — a 50x overstatement on the cached 4.
    expect(result.usage.inputTokens).toBe(9);
    expect(result.usage.cacheReadTokens).toBe(4);
    expect(result.usage.outputTokens).toBe(9);
  });

  test('falls back to the generic shape when the split is absent, rather than reporting nonsense', async () => {
    const plain = startMockOpenAi(); // openai dialect
    try {
      const result = await deepseek({}, plain).generate(request());
      // prompt_tokens 13, cached 4 → 9 billed at full rate.
      expect(result.usage.inputTokens).toBe(9);
      expect(result.usage.cacheReadTokens).toBe(4);
    } finally {
      plain.stop();
    }
  });

  test('reasoning_content NEVER lands in text (non-streaming)', async () => {
    const thinking = startMockOpenAi({
      usageDialect: 'deepseek',
      text: '{"ok":true}',
      reasoning: 'Let me consider the schema carefully...',
    });
    try {
      const result = await deepseek({}, thinking).generate(request());

      expect(result.text).toBe('{"ok":true}');
      expect(result.text).not.toContain('consider');
    } finally {
      thinking.stop();
    }
  });

  test('reasoning streams as thinking events; TEXT deltas still equal finalResult().text exactly', async () => {
    const thinking = startMockOpenAi({
      usageDialect: 'deepseek',
      text: 'The answer.',
      reasoning: 'First I will think about it.',
    });
    try {
      const stream = deepseek({}, thinking).stream(request());

      let text = '';
      let reasoning = '';
      for await (const event of stream) {
        if (event.type === 'text') text += event.delta;
        if (event.type === 'thinking') reasoning += event.delta;
      }
      const final = await stream.finalResult();

      // The conformance invariant, on a reasoning model: the chain-of-thought is
      // surfaced but never enters either side of the equation.
      expect(text).toBe(final.text);
      expect(final.text).toBe('The answer.');
      expect(reasoning).toBe('First I will think about it.');
      expect(final.text).not.toContain('think about it');
    } finally {
      thinking.stop();
    }
  });

  test('requires an API key', () => {
    expect(() =>
      createDeepSeekProvider('deepseek', {}, { apiKey: null, logger: silentLogger }),
    ).toThrow(AiConfigError);
  });
});

// ---------------------------------------------------------------------------
// The one that proves multi-provider is real
// ---------------------------------------------------------------------------

describe('a json-mode provider round-trips a schema through the orchestrator', () => {
  const Card = z.object({
    kind: z.enum(['truth', 'dare']),
    text: z.string(),
  });

  function clientFor(server: ReturnType<typeof startMockOpenAi>) {
    const provider = deepseek({}, server);
    const config = aiPackageConfigSchema.parse({
      providers: { deepseek: { provider } },
      defaultProvider: 'deepseek',
      moderation: { enabled: false },
      usage: { enabled: false, persist: false },
      spend: { enabled: false },
    });
    return createAiClient({
      config,
      providers: new Map([['deepseek', provider]]),
      logger: silentLogger,
    }).client;
  }

  test('json-mode: schema goes in the PROMPT as well as response_format — which is also how DeepSeek gets its required "json" keyword', async () => {
    const server = startMockOpenAi({
      usageDialect: 'deepseek',
      text: '{"kind":"dare","text":"Sing the chorus."}',
    });
    try {
      const client = clientFor(server);
      const result = await client.generateStructured({
        schema: Card,
        schemaName: 'card',
        system: { stable: [{ id: 'rules', text: 'You write party cards.' }] },
        messages: [{ role: 'user', content: 'One card.' }],
      });

      expect(result.value).toEqual({ kind: 'dare', text: 'Sing the chorus.' });

      const body = server.requests.at(-1)!;
      // json-mode sets response_format...
      expect(body.response_format).toEqual({ type: 'json_object' });
      // ...AND injects the schema into the system prompt. DeepSeek requires the
      // literal word "json" to appear in the prompt; jsonInstruction() supplies
      // it, so that requirement is met by construction rather than by luck.
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find(m => m.role === 'system')!.content;
      expect(system.toLowerCase()).toContain('json');
      expect(system).toContain('"kind"');

      // The shortfall is REPORTED, not hidden.
      expect(result.degradations.map(d => d.feature)).toContain('structuredOutput');
    } finally {
      server.stop();
    }
  });

  test('a json-mode provider that returns fenced prose is REPAIRED into a valid object', async () => {
    // Exactly what a weaker model does under json-mode: valid-ish JSON wrapped in
    // a fence with a preamble. A `native` provider never exercises this path,
    // which is why DeepSeek is the provider that proves the fallback works.
    const server = startMockOpenAi({
      usageDialect: 'deepseek',
      text: 'Sure! Here is the card:\n```json\n{"kind":"truth","text":"Biggest lie?"}\n```',
    });
    try {
      const client = clientFor(server);
      const result = await client.generateStructured({
        schema: Card,
        schemaName: 'card',
        system: { stable: [{ id: 'rules', text: 'You write party cards.' }] },
        messages: [{ role: 'user', content: 'One card.' }],
      });

      expect(result.value).toEqual({ kind: 'truth', text: 'Biggest lie?' });
      // Extracted on the first attempt — no repair turn needed.
      expect(server.requests.length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("DeepSeek's documented empty-content quirk drives the repair loop rather than surfacing as a crash", async () => {
    // "When using the JSON Output feature, the API may occasionally return empty
    // content." Empty text cannot parse, so it must land in the repair loop.
    const server = startMockOpenAi({ usageDialect: 'deepseek', text: '' });
    try {
      const client = clientFor(server);
      const error = await client
        .generateStructured({
          schema: Card,
          schemaName: 'card',
          system: { stable: [{ id: 'rules', text: 'You write party cards.' }] },
          messages: [{ role: 'user', content: 'One card.' }],
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      // 1 initial attempt + 2 repairs — it retried rather than throwing on the
      // first empty body.
      expect(server.requests.length).toBe(3);
    } finally {
      server.stop();
    }
  });
});
