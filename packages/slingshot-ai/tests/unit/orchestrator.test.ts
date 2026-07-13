/**
 * Orchestrator behavior that does not depend on any real provider.
 *
 * The theme of this file is the package's central claim: it never silently does
 * less than you asked for. Every test here is a case where a naive
 * implementation would quietly succeed with a worse result.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type AiPackageConfigInput, aiPackageConfigSchema } from '../../src/config';
import {
  AiRefusalError,
  AiSpendLimitError,
  AiStructuredOutputError,
  AiUnsupportedFeatureError,
} from '../../src/errors';
import { createAiClient } from '../../src/lib/client';
import type { AiProvider } from '../../src/provider/types';
import { createFakeAiProvider, scriptedModerator } from '../../src/testing';
import type { AiClient } from '../../src/types';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function build(
  provider: AiProvider,
  overrides: Partial<AiPackageConfigInput> = {},
): { client: AiClient; usage: ReturnType<typeof createAiClient>['usage'] } {
  const config = aiPackageConfigSchema.parse({
    providers: { test: { provider } },
    defaultProvider: 'test',
    ...overrides,
  });
  const { client, usage } = createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
  });
  return { client, usage };
}

const ask = { messages: [{ role: 'user' as const, content: 'go' }] };

describe('degradation accounting', () => {
  test('a fully capable provider degrades nothing', async () => {
    const provider = createFakeAiProvider({
      responses: ['ok'],
      capabilities: {
        streaming: true,
        thinking: 'adaptive',
        effort: true,
        costAccounting: true,
        refusalSignal: true,
      },
    });
    const { client } = build(provider);

    const result = await client.generate({ ...ask, thinking: true, effort: 'high' });

    // The assertion an app can actually rely on: empty means everything you
    // asked for was honored.
    expect(result.degradations).toEqual([]);
  });

  test('records a degradation when thinking and effort are unsupported', async () => {
    const { client } = build(createFakeAiProvider({ responses: ['ok'] }));

    const result = await client.generate({ ...ask, thinking: true, effort: 'max' });
    const features = result.degradations.map(d => d.feature);

    expect(features).toContain('thinking');
    expect(features).toContain('effort');
    // The conservative fake also can't price or signal refusals — and says so.
    expect(features).toContain('costAccounting');
    expect(features).toContain('refusalSignal');
  });

  test("degradation: 'strict' throws instead of quietly doing less", async () => {
    const { client } = build(createFakeAiProvider({ responses: ['ok'] }), {
      degradation: 'strict',
    });

    await expect(client.generate({ ...ask, thinking: true })).rejects.toThrow(
      AiUnsupportedFeatureError,
    );
  });

  test('a non-streaming provider still yields a correct stream, and says it is not incremental', async () => {
    const { client } = build(createFakeAiProvider({ responses: ['one two three'] }));

    const stream = client.stream(ask);
    const deltas: string[] = [];
    for await (const event of stream) {
      if (event.type === 'text') deltas.push(event.delta);
    }
    const final = await stream.finalResult();

    expect(deltas.join('')).toBe('one two three');
    expect(final.value).toBe('one two three');
    expect(final.degradations.map(d => d.feature)).toContain('streaming');
  });
});

describe('refusals', () => {
  test('a refusal throws rather than returning empty text as success', async () => {
    // Anthropic returns HTTP 200 with empty content on a refusal. Silently
    // treating that as a successful generation ships a blank card to the table.
    const provider = createFakeAiProvider({
      responses: [{ text: '', stopReason: 'refusal' }],
      capabilities: { refusalSignal: true },
    });
    const { client } = build(provider);

    await expect(client.generate(ask)).rejects.toThrow(AiRefusalError);
  });
});

describe('cost honesty', () => {
  test('an unpriced provider reports costUsd: null, not 0', async () => {
    const { client, usage } = build(createFakeAiProvider({ responses: ['ok'] }));

    const result = await client.generate(ask);
    expect(result.usage.costUsd).toBeNull();

    // And the summary keeps the unknown visible rather than summing it as zero.
    const summary = await usage.summary();
    expect(summary.costUsd).toBe(0);
    expect(summary.unpricedCalls).toBe(1);
  });

  test("pricing: 'free' means genuinely zero, which is NOT the same as unknown", async () => {
    const provider = createFakeAiProvider({
      responses: ['ok'],
      capabilities: { costAccounting: true },
    });
    const config = aiPackageConfigSchema.parse({
      providers: { test: { provider, pricing: 'free' } },
      defaultProvider: 'test',
    });
    const { client, usage } = createAiClient({
      config,
      providers: new Map([['test', provider]]),
      logger: silentLogger,
    });

    const result = await client.generate(ask);
    expect(result.usage.costUsd).toBe(0);

    const summary = await usage.summary();
    expect(summary.unpricedCalls).toBe(0);
  });
});

describe('spend guard', () => {
  test('blocks the call BEFORE it is made once the hard limit is reached', async () => {
    const provider = createFakeAiProvider({
      responses: ['ok'],
      capabilities: { costAccounting: true },
    });
    const config = aiPackageConfigSchema.parse({
      providers: {
        test: {
          provider,
          pricing: { 'fake-model-1': { inputPerMTok: 1000, outputPerMTok: 1000 } },
        },
      },
      defaultProvider: 'test',
      spend: { hardLimitUsd: 0.001 },
      defaults: { maxTokens: 4096 },
    });
    const { client } = createAiClient({
      config,
      providers: new Map([['test', provider]]),
      logger: silentLogger,
    });

    // maxTokens 4096 at $1000/MTok ≈ $4 — far over the $0.001 limit.
    await expect(client.generate(ask)).rejects.toThrow(AiSpendLimitError);

    // The point of PRE-flight: the provider was never called at all.
    expect(provider.calls).toHaveLength(0);
  });
});

describe('structured output', () => {
  const Deck = z.object({ cards: z.array(z.string()) });

  test("validates the provider's advisory object rather than trusting it", async () => {
    // A "native" provider that returns the WRONG SHAPE. Trusting `structured`
    // would hand the app a `{ cards: "not an array" }` and let it explode later,
    // far from here.
    const provider = createFakeAiProvider({
      responses: [{ text: '{}', structured: { cards: 'not an array' } }],
      capabilities: { structuredOutput: 'native' },
    });
    const { client } = build(provider);

    await expect(client.generateStructured({ ...ask, schema: Deck })).rejects.toThrow(
      AiStructuredOutputError,
    );
  });

  test('falls back to the text when the provider returns a null advisory value', async () => {
    // Anthropic returns `parsed_output: null` in some cases while still emitting
    // the JSON as text. The orchestrator must not treat that as a failure.
    const provider = createFakeAiProvider({
      responses: [{ text: '{"cards":["a","b"]}', structured: null }],
      capabilities: { structuredOutput: 'native' },
    });
    const { client } = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Deck });
    expect(result.value.cards).toEqual(['a', 'b']);
  });

  test('json-mode is recorded as a degradation from native', async () => {
    const provider = createFakeAiProvider({
      responses: [{ text: '{"cards":["a"]}' }],
      capabilities: { structuredOutput: 'json-mode' },
    });
    const { client } = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Deck });
    expect(result.value.cards).toEqual(['a']);
    expect(result.degradations.map(d => d.feature)).toContain('structuredOutput');
  });

  test('a provider with NO structured support still works, via the prompt path', async () => {
    // The whole point: this is the local-model / small-model case. The schema is
    // injected into the prompt, the text is extracted and validated, and the
    // shortfall is reported rather than hidden.
    const provider = createFakeAiProvider({ responses: ['{"cards":["a"]}'] });
    const { client } = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Deck });

    expect(result.value.cards).toEqual(['a']);
    expect(result.degradations.map(d => d.feature)).toContain('structuredOutput');

    // The schema went into the prompt, since the provider can't take it any other way.
    const systemText = provider.calls[0]?.system.map(block => block.text).join('\n') ?? '';
    expect(systemText).toContain('JSON Schema');
  });

  test("degradation: 'strict' refuses the prompt fallback rather than doing less", async () => {
    const { client } = build(createFakeAiProvider({ responses: ['{"cards":[]}'] }), {
      degradation: 'strict',
    });

    await expect(client.generateStructured({ ...ask, schema: Deck })).rejects.toThrow(
      AiUnsupportedFeatureError,
    );
  });
});

describe('moderation', () => {
  test('reports a verdict on the result by default', async () => {
    const { client } = build(createFakeAiProvider({ responses: ['something rude'] }), {
      moderation: { moderator: scriptedModerator({ block: /rude/ }) },
    });

    const result = await client.generate({ ...ask, moderation: { policy: 'default' } });
    expect(result.moderation?.allowed).toBe(false);
  });

  test("onBlocked: 'throw' raises instead", async () => {
    const { client } = build(createFakeAiProvider({ responses: ['something rude'] }), {
      moderation: { moderator: scriptedModerator({ block: /rude/ }) },
    });

    await expect(
      client.generate({ ...ask, moderation: { policy: 'default', onBlocked: 'throw' } }),
    ).rejects.toThrow(/blocked/i);
  });

  test('fails CLOSED when a requested policy is not defined', async () => {
    // The alternative — quietly allowing everything because the policy name was
    // a typo — is the worst possible outcome for a safety control, because the
    // app believes it has one.
    const { client } = build(createFakeAiProvider({ responses: ['anything'] }));

    await expect(client.generate({ ...ask, moderation: { policy: 'default' } })).rejects.toThrow(
      /policy 'default' is not defined/,
    );
  });

  test('is skipped entirely when the request does not ask for it', async () => {
    const { client } = build(createFakeAiProvider({ responses: ['fine'] }));

    const result = await client.generate(ask);
    expect(result.moderation).toBeNull();
  });
});

describe('response cache', () => {
  test('is off by default — a party game wants variety, not determinism', async () => {
    const provider = createFakeAiProvider({ handler: (_req, index) => `answer ${index}` });
    const { client } = build(provider);

    const first = await client.generate(ask);
    const second = await client.generate(ask);

    expect(first.value).toBe('answer 0');
    expect(second.value).toBe('answer 1');
    expect(second.cached).toBe('none');
  });

  test('an explicit cache request opts in, and the second call never reaches the provider', async () => {
    const provider = createFakeAiProvider({ handler: (_req, index) => `answer ${index}` });
    const { client } = build(provider);

    const first = await client.generate({ ...ask, cache: { ttlSeconds: 60 } });
    const second = await client.generate({ ...ask, cache: { ttlSeconds: 60 } });

    expect(second.value).toBe(first.value);
    expect(second.cached).toBe('response');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('capability introspection', () => {
  test('capabilitiesOf() answers "does this provider actually support X?"', async () => {
    const { client } = build(
      createFakeAiProvider({ capabilities: { structuredOutput: 'native', streaming: true } }),
    );

    const caps = client.capabilitiesOf();
    expect(caps.structuredOutput).toBe('native');
    expect(caps.streaming).toBe(true);
    expect(caps.thinking).toBe('none');
  });

  test('countTokens() returns null when the provider cannot count', async () => {
    const provider = createFakeAiProvider();
    const noCount: AiProvider = { ...provider, countTokens: undefined };
    const { client } = build(noCount);

    expect(await client.countTokens(ask)).toBeNull();
  });
});
