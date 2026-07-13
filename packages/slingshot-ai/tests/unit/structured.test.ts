/**
 * Structured output against a provider that guarantees NOTHING.
 *
 * This is the riskiest code in the package, so these tests feed it the things
 * models actually emit, not the things we wish they emitted: fenced code blocks,
 * cheerful preambles, trailing commas, single quotes, truncated JSON, and —
 * worst of all — perfectly valid JSON of entirely the wrong shape.
 *
 * Two properties are being proven:
 *
 *   1. The repair loop CONVERGES on output a naive `JSON.parse` would reject.
 *   2. When it can't, it GIVES UP CLEANLY — a bounded number of attempts and an
 *      `AiStructuredOutputError` carrying the raw text and the zod error —
 *      rather than looping against a stubborn model, which is an infinite bill.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type AiPackageConfigInput, aiPackageConfigSchema } from '../../src/config';
import { AiConfigError, AiStructuredOutputError } from '../../src/errors';
import { createAiClient } from '../../src/lib/client';
import {
  chooseStructuredMode,
  extractJson,
  parseStructured,
  sanitizeJsonSchema,
  toJsonSchema,
} from '../../src/lib/structured';
import { CONSERVATIVE_CAPABILITIES } from '../../src/provider/capabilities';
import { type FakeResponse, createFakeAiProvider } from '../../src/testing';
import type { AiClient } from '../../src/types';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const Deck = z.object({
  title: z.string(),
  cards: z.array(z.string()),
});

/** A provider with NO structured-output support — the prompt path. */
function dumbProvider(responses: readonly FakeResponse[]) {
  return createFakeAiProvider({
    responses,
    capabilities: { structuredOutput: 'none' },
  });
}

function build(
  provider: ReturnType<typeof createFakeAiProvider>,
  overrides: Partial<AiPackageConfigInput> = {},
): AiClient {
  const config = aiPackageConfigSchema.parse({
    providers: { test: { provider } },
    defaultProvider: 'test',
    degradation: 'silent', // keep the logs quiet; degradations are still recorded
    ...overrides,
  });
  return createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
  }).client;
}

const ask = { messages: [{ role: 'user' as const, content: 'make a deck' }] };

// ---------------------------------------------------------------------------
// The adversarial corpus: things models really say when asked for JSON.
// ---------------------------------------------------------------------------

const GOOD = '{"title":"Party","cards":["a","b"]}';

describe('first-attempt recovery (no repair turn needed)', () => {
  const cases: Array<{ name: string; text: string }> = [
    {
      name: 'a fenced ```json block',
      text: '```json\n{"title":"Party","cards":["a","b"]}\n```',
    },
    {
      name: 'a fenced block with no language tag',
      text: '```\n{"title":"Party","cards":["a","b"]}\n```',
    },
    {
      name: 'a cheerful preamble',
      text: 'Sure! Here\'s the JSON you asked for:\n\n{"title":"Party","cards":["a","b"]}',
    },
    {
      name: 'preamble AND a fence AND a trailing sign-off',
      text: 'Here you go:\n```json\n{"title":"Party","cards":["a","b"]}\n```\nHope that helps!',
    },
    {
      name: 'a trailing comma',
      text: '{"title":"Party","cards":["a","b",],}',
    },
    {
      name: 'single-quoted keys and values',
      text: "{'title':'Party','cards':['a','b']}",
    },
    {
      name: 'a prose sentence containing braces in a string',
      text: 'The deck is: {"title":"Party {night}","cards":["a","b"]} — enjoy.',
    },
  ];

  for (const { name, text } of cases) {
    test(`recovers from ${name}`, async () => {
      const provider = dumbProvider([text]);
      const client = build(provider);

      const result = await client.generateStructured({ ...ask, schema: Deck });

      expect(result.value.cards).toEqual(['a', 'b']);
      // Recovered mechanically — the model was never asked to try again.
      expect(provider.calls).toHaveLength(1);
    });
  }

  test('a brace inside a string does not truncate the extraction', () => {
    const extracted = extractJson('Result: {"title":"a } b","cards":[]} done');
    expect(extracted).toBe('{"title":"a } b","cards":[]}');
  });
});

describe('the repair loop', () => {
  test('converges after a repair turn when the first reply is the wrong SHAPE', async () => {
    // Valid JSON, entirely wrong shape. No amount of regex fixes this — only
    // showing the model its validation errors does.
    const provider = dumbProvider([{ text: '{"deck":{"name":"Party"}}' }, { text: GOOD }]);
    const client = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Deck });

    expect(result.value.title).toBe('Party');
    expect(provider.calls).toHaveLength(2);

    // The repair turn must SHOW the model what was wrong — otherwise it's just
    // rolling the dice again.
    const repairTurn = provider.calls[1]?.messages.at(-1);
    expect(repairTurn?.role).toBe('user');
    expect(repairTurn?.content).toContain('did not conform');
    expect(repairTurn?.content).toMatch(/title|cards/);

    // ...and it must include the model's own previous answer as an assistant
    // turn, or the conversation makes no sense to the model.
    expect(provider.calls[1]?.messages.at(-2)?.role).toBe('assistant');
  });

  test('converges from truncated JSON (a max_tokens cutoff)', async () => {
    const provider = dumbProvider([{ text: '{"title":"Party","cards":["a",' }, { text: GOOD }]);
    const client = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Deck });

    expect(result.value.cards).toEqual(['a', 'b']);
    expect(provider.calls).toHaveLength(2);
  });

  test('converges from prose with no JSON at all', async () => {
    const provider = dumbProvider([
      { text: 'I think a party deck should have cards about music and food.' },
      { text: GOOD },
    ]);
    const client = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Deck });
    expect(result.value.title).toBe('Party');
  });

  test('GIVES UP CLEANLY rather than looping forever', async () => {
    // A model that simply cannot produce the shape. The loop must be bounded:
    // an unbounded repair loop against a stubborn model is an infinite bill.
    const provider = dumbProvider([{ text: 'nope, still not JSON' }]);
    const client = build(provider);

    const failure = client.generateStructured({ ...ask, schema: Deck });
    await expect(failure).rejects.toThrow(AiStructuredOutputError);

    // 1 initial attempt + maxRepairAttempts (default 2) = 3. Not 4, not forever.
    expect(provider.calls).toHaveLength(3);

    // And the error carries what a human needs to debug it.
    try {
      await client.generateStructured({ ...ask, schema: Deck });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AiStructuredOutputError);
      const structured = error as AiStructuredOutputError;
      expect(structured.rawText).toContain('nope');
      expect(structured.zodError).toBeDefined();
      expect(structured.attempts).toBe(3);
    }
  });

  test('honors maxRepairAttempts: 0 — one attempt, no repair', async () => {
    const provider = dumbProvider([{ text: 'not json' }]);
    const client = build(provider, { structuredFallback: { maxRepairAttempts: 0 } });

    await expect(client.generateStructured({ ...ask, schema: Deck })).rejects.toThrow(
      AiStructuredOutputError,
    );
    expect(provider.calls).toHaveLength(1);
  });

  test('every repair attempt re-enters the spend guard', async () => {
    // The invariant that keeps a repair loop from becoming a runaway bill: the
    // guard is checked before EVERY attempt, not once at the top of the call.
    const provider = createFakeAiProvider({
      // The first attempt is unparseable AND expensive: 1M output tokens.
      responses: [{ text: 'not json', usage: { outputTokens: 1_000_000 } }],
      capabilities: { structuredOutput: 'none', costAccounting: true },
    });
    const config = aiPackageConfigSchema.parse({
      providers: {
        test: {
          provider,
          pricing: { 'fake-model-1': { inputPerMTok: 1, outputPerMTok: 10 } },
        },
      },
      defaultProvider: 'test',
      degradation: 'silent',
      // The first attempt fits (its worst case is cents). Its ACTUAL cost is $10,
      // which blows the budget — so the repair attempt must be refused.
      spend: { hardLimitUsd: 5 },
      defaults: { maxTokens: 4096 },
    });
    const client = createAiClient({
      config,
      providers: new Map([['test', provider]]),
      logger: silentLogger,
    }).client;

    // The failure is a SPEND error, not a structured-output error: the loop was
    // CUT OFF, not exhausted. A guard checked only once at the top of the call
    // would have let all three attempts through and billed for them.
    await expect(client.generateStructured({ ...ask, schema: Deck })).rejects.toThrow(
      /spend limit/i,
    );
    expect(provider.calls).toHaveLength(1);
  });
});

describe('sanitizeJsonSchema', () => {
  test('strips the keywords strict structured-output providers reject', () => {
    // `z.string().max(240)` → `maxLength: 240`, which Anthropic 400s on. A
    // perfectly reasonable card schema would fail on the very first call.
    const { schema, stripped } = sanitizeJsonSchema({
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 240, minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        cards: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      },
    });

    const json = JSON.stringify(schema);
    expect(json).not.toContain('maxLength');
    expect(json).not.toContain('minItems');
    expect(json).not.toContain('minimum');
    expect(stripped).toContain('maxLength');
    expect(stripped).toContain('minItems');
  });

  test('forces additionalProperties: false on every object', () => {
    const { schema } = sanitizeJsonSchema({
      type: 'object',
      properties: { nested: { type: 'object', properties: {} } },
    });

    expect((schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    const nested = (schema as { properties: { nested: { additionalProperties: boolean } } })
      .properties.nested;
    expect(nested.additionalProperties).toBe(false);
  });

  test('the stripped CONSTRAINTS are still enforced — by zod, on the result', async () => {
    // This is why stripping is safe rather than sloppy: the model isn't told
    // about the bounds, but the answer is still validated against the real
    // schema, so a violation is caught and repaired.
    const Bounded = z.object({ title: z.string().max(5) });
    const provider = dumbProvider([
      { text: '{"title":"way too long to fit"}' },
      { text: '{"title":"short"}' },
    ]);
    const client = build(provider);

    const result = await client.generateStructured({ ...ask, schema: Bounded });

    expect(result.value.title).toBe('short');
    expect(provider.calls).toHaveLength(2); // the over-length reply was rejected and repaired
  });

  test('rejects a recursive schema loudly instead of sending something that 400s', () => {
    const recursive: Record<string, unknown> = { type: 'object' };
    recursive.properties = { self: recursive };

    expect(() => sanitizeJsonSchema(recursive)).toThrow(AiConfigError);
  });

  test('warns when it strips, and throws under strict', () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (m: string) => void warnings.push(m) };
    const Bounded = z.object({ title: z.string().max(5) });

    toJsonSchema(Bounded, { logger, strict: false, name: 'deck' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('maxLength');

    expect(() => toJsonSchema(Bounded, { logger, strict: true, name: 'deck' })).toThrow(
      AiConfigError,
    );
  });
});

describe('parseStructured — the single validation point', () => {
  test('accepts a valid advisory object', () => {
    const parsed = parseStructured({
      schema: Deck,
      advisory: { title: 'Party', cards: ['a'] },
      text: 'irrelevant',
    });
    expect(parsed.ok).toBe(true);
  });

  test('does not trust an advisory object of the wrong shape', () => {
    // A "native" provider that got it wrong. Trusting `structured` here is how
    // you hand an app a value that explodes far away from this code.
    const parsed = parseStructured({
      schema: Deck,
      advisory: { title: 'Party', cards: 'not-an-array' },
      text: '{"title":"Party","cards":["a"]}',
    });
    // Falls through to the text, which IS valid — so this recovers.
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.cards).toEqual(['a']);
  });

  test('falls back to the text when the advisory value is null (Anthropic does this)', () => {
    const parsed = parseStructured({
      schema: Deck,
      advisory: null,
      text: '{"title":"Party","cards":[]}',
    });
    expect(parsed.ok).toBe(true);
  });

  test('reports the zod error, not a generic one, when the shape is wrong', () => {
    const parsed = parseStructured({
      schema: Deck,
      text: '{"title":"Party"}', // missing `cards`
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeInstanceOf(z.ZodError);
  });
});

describe('chooseStructuredMode', () => {
  test('maps declared capability to strategy', () => {
    expect(chooseStructuredMode({ ...CONSERVATIVE_CAPABILITIES, structuredOutput: 'native' })).toBe(
      'native',
    );
    expect(
      chooseStructuredMode({ ...CONSERVATIVE_CAPABILITIES, structuredOutput: 'json-mode' }),
    ).toBe('json-mode');
    expect(chooseStructuredMode(CONSERVATIVE_CAPABILITIES)).toBe('prompt');
  });
});
