/**
 * Anthropic adapter — the provider contract, plus the behaviors that are unique
 * to this provider and easy to get wrong.
 *
 * Runs against a local mock speaking the real Messages wire format (including
 * the real SSE event sequence), so it needs no key and no network. The live
 * suite in `tests/live/` is the one that talks to the actual API.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { AiProviderError, AiRateLimitError } from '../../src/errors';
import { createAnthropicProvider } from '../../src/provider/anthropic';
import type { NormalizedRequest } from '../../src/provider/types';
import { runProviderConformanceSuite } from '../../src/testing';
import { startMockAnthropic } from '../support/mockServers';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const mock = startMockAnthropic();
afterAll(() => mock.stop());

function build(server = mock) {
  return createAnthropicProvider(
    'anthropic',
    { baseUrl: server.url, apiKey: 'sk-mock' },
    { apiKey: 'sk-mock', logger: silentLogger },
  );
}

runProviderConformanceSuite('anthropic', () => build());

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'claude-opus-4-8',
    system: [{ text: 'You are a fixture.', cache: false }],
    messages: [{ role: 'user', content: 'Say hello.' }],
    maxTokens: 256,
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('anthropic adapter', () => {
  test('never sends temperature, top_p, or top_k (all 400 on Opus 4.8)', async () => {
    const provider = await build();
    await provider.generate(request({ effort: 'high', thinking: true }));

    const sent = mock.requests.at(-1)!;
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).not.toHaveProperty('top_p');
    expect(sent).not.toHaveProperty('top_k');
  });

  test('sends adaptive thinking and effort via output_config', async () => {
    const provider = await build();
    await provider.generate(request({ effort: 'xhigh', thinking: true }));

    const sent = mock.requests.at(-1)!;
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.output_config).toMatchObject({ effort: 'xhigh' });
  });

  test('places a cache_control breakpoint only on the block the orchestrator marked', async () => {
    const provider = await build();
    await provider.generate(
      request({
        system: [
          { text: 'stable rules', cache: true },
          { text: 'volatile roster', cache: false },
        ],
      }),
    );

    const system = mock.requests.at(-1)!.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]!.cache_control).toBeUndefined();
  });

  test('sends the orchestrator sanitized schema as output_config.format', async () => {
    const provider = await build();
    const jsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
    await provider.generate(
      request({
        structured: {
          name: 'card',
          zod: null as never,
          jsonSchema,
          mode: 'native',
        },
      }),
    );

    const outputConfig = mock.requests.at(-1)!.output_config as Record<string, unknown>;
    expect(outputConfig.format).toEqual({ type: 'json_schema', schema: jsonSchema });
  });

  test('reports the cache read/write breakdown (usageAccounting: full)', async () => {
    const provider = await build();
    const result = await provider.generate(request());

    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
    });
  });

  test('a refusal is a 200 with no content — reported, not crashed on', async () => {
    // The trap: `stop_reason: 'refusal'` arrives as HTTP 200 with an EMPTY
    // content array. An adapter that reaches for content[0].text first throws a
    // TypeError, and the orchestrator never gets to raise AiRefusalError.
    const refusing = startMockAnthropic({ stopReason: 'refusal', text: '' });
    try {
      const provider = await build(refusing);
      const result = await provider.generate(request());

      expect(result.stopReason).toBe('refusal');
      expect(result.text).toBe('');
    } finally {
      refusing.stop();
    }
  });

  test('maps 429 to AiRateLimitError and honors retry-after', async () => {
    const limited = startMockAnthropic({ status: 429, headers: { 'retry-after': '2' } });
    try {
      const provider = await build(limited);
      const error = await provider.generate(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiRateLimitError);
      expect((error as AiRateLimitError).retryAfterMs).toBe(2000);
      expect((error as AiRateLimitError).retryable).toBe(true);
    } finally {
      limited.stop();
    }
  });

  test('maps 400 to a NON-retryable error (a bad schema fails identically forever)', async () => {
    const bad = startMockAnthropic({ status: 400 });
    try {
      const provider = await build(bad);
      const error = await provider.generate(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).retryable).toBe(false);
      expect((error as AiProviderError).status).toBe(400);
    } finally {
      bad.stop();
    }
  });

  test('maps 500 to a retryable error', async () => {
    const broken = startMockAnthropic({ status: 500 });
    try {
      const provider = await build(broken);
      const error = await provider.generate(request()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).retryable).toBe(true);
    } finally {
      broken.stop();
    }
  });

  test('countTokens strips max_tokens and output_config', async () => {
    const provider = await build();
    const count = await provider.countTokens!(request({ effort: 'low' }));

    expect(count).toBe(42);
    const sent = mock.requests.at(-1)!;
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent).not.toHaveProperty('output_config');
  });

  test('a huge maxTokens transparently routes through the streaming API', async () => {
    const provider = await build();
    const result = await provider.generate(request({ maxTokens: 32_000 }));

    // Same ProviderResult either way — the caller cannot tell.
    expect(result.text).toBe('Hello from the mock.');
    expect(mock.requests.at(-1)!.stream).toBe(true);
  });

  test('finalResult() works without iterating the stream', async () => {
    const provider = await build();
    const result = await provider.stream(request()).finalResult();
    expect(result.text).toBe('Hello from the mock.');
  });
});
