/**
 * The only tests in this package that spend money.
 *
 * Skipped unless `SLINGSHOT_AI_LIVE=1` and a key is present, so the default
 * suite stays hermetic, free, and offline. Run them when the SDK is upgraded or
 * a model is swapped — they are what catches an API surface change that a mock,
 * by definition, cannot.
 *
 *   SLINGSHOT_AI_LIVE=1 ANTHROPIC_API_KEY=sk-... bun test packages/slingshot-ai/tests/live
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { aiPackageConfigSchema } from '../../src/config';
import { createAiClient } from '../../src/lib/client';
import { createAnthropicProvider } from '../../src/provider/anthropic';
import type { AiProvider } from '../../src/provider/types';

const LIVE = Bun.env.SLINGSHOT_AI_LIVE === '1' && Boolean(Bun.env.ANTHROPIC_API_KEY);

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function liveProvider(): Promise<AiProvider> {
  return createAnthropicProvider(
    'anthropic',
    { apiKey: Bun.env.ANTHROPIC_API_KEY },
    { apiKey: Bun.env.ANTHROPIC_API_KEY ?? null, logger: silentLogger },
  );
}

function clientFor(provider: AiProvider) {
  const config = aiPackageConfigSchema.parse({
    providers: { anthropic: {} },
    defaultProvider: 'anthropic',
  });
  return createAiClient({
    config,
    providers: new Map([['anthropic', provider]]),
    logger: silentLogger,
  }).client;
}

describe('anthropic (live)', () => {
  test.skipIf(!LIVE)(
    'generates text and reports real usage',
    async () => {
      const provider = await liveProvider();
      const result = await provider.generate({
        model: 'claude-haiku-4-5',
        system: [{ text: 'Answer in exactly one word.', cache: false }],
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
        maxTokens: 32,
        timeoutMs: 30_000,
      });

      expect(result.text.toLowerCase()).toContain('paris');
      expect(result.stopReason).toBe('end');
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!LIVE)(
    'native structured output validates against the real schema',
    async () => {
      // The whole point of the live suite: this is the call that proves the
      // sanitized JSON Schema we send is one the API actually accepts. A mock
      // cannot fail the way a 400 from `output_config.format` fails.
      const Card = z.object({
        answer: z.string().max(60),
        confidence: z.number().int().min(1).max(5),
      });

      const client = clientFor(await liveProvider());
      const result = await client.generateStructured({
        schema: Card,
        schemaName: 'card',
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'user', content: 'What is the capital of France? Rate your confidence.' },
        ],
        maxTokens: 256,
      });

      expect(result.value.answer.toLowerCase()).toContain('paris');
      expect(result.value.confidence).toBeGreaterThanOrEqual(1);
      // Native structured output on a native provider: nothing should have degraded.
      expect(result.degradations.filter(d => d.feature === 'structuredOutput')).toHaveLength(0);
    },
    60_000,
  );

  test.skipIf(!LIVE)(
    'streaming deltas concatenate to the final text',
    async () => {
      const provider = await liveProvider();
      const stream = provider.stream({
        model: 'claude-haiku-4-5',
        system: [],
        messages: [{ role: 'user', content: 'Count from one to five, in words.' }],
        maxTokens: 128,
        timeoutMs: 30_000,
      });

      let accumulated = '';
      for await (const event of stream) {
        if (event.type === 'text') accumulated += event.delta;
      }
      const final = await stream.finalResult();

      expect(accumulated).toBe(final.text);
      expect(accumulated.length).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!LIVE)(
    'countTokens returns a real count',
    async () => {
      const provider = await liveProvider();
      const count = await provider.countTokens!({
        model: 'claude-haiku-4-5',
        system: [{ text: 'You are helpful.', cache: false }],
        messages: [{ role: 'user', content: 'Hello.' }],
        maxTokens: 64,
        timeoutMs: 30_000,
      });

      expect(count).toBeGreaterThan(0);
    },
    60_000,
  );
});
