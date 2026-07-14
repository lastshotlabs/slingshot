/**
 * What actually goes ON THE WIRE, per vendor.
 *
 * Three findings pinned here, all verified against the live APIs on 2026-07-13
 * and all of them silent failures:
 *
 * 1. **OpenAI renamed the token-limit parameter.** Every model it currently ships
 *    hard-400s on `max_tokens` ("Use 'max_completion_tokens' instead"). The
 *    `openai` preset was therefore broken against every current OpenAI model and
 *    worked only on the legacy `gpt-4o` line it happened to default to.
 *
 * 2. **DeepSeek's thinking mode DEFAULTS TO ENABLED.** Not sending the flag does
 *    not mean off — it means on, and it means paying for a chain-of-thought on
 *    every call (9× the output tokens on a trivial prompt). "Off" must be stated.
 *
 * 3. **DeepSeek hard-requires the literal word "json"** in the prompt whenever
 *    `response_format: json_object` is used, or it 400s. The orchestrator's
 *    `jsonInstruction()` satisfies this for free today — which is exactly the kind
 *    of load-bearing accident that a future "let's tighten this wording" commit
 *    would silently break.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AiProviderConfig } from '../../src/config';
import { jsonInstruction } from '../../src/lib/structured';
import {
  createDeepSeekProvider,
  createGrokProvider,
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
} from '../../src/provider/openaiCompatible';
import type { NormalizedRequest } from '../../src/provider/types';
import { startMockOpenAi } from '../support/mockServers';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const mock = startMockOpenAi();
afterAll(() => mock.stop());

function config(extra: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return { baseUrl: mock.url, defaultModel: 'mock-model', ...extra };
}

function request(extra: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'mock-model',
    system: [{ text: 'fixture', cache: false }],
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 128,
    timeoutMs: 10_000,
    ...extra,
  };
}

/** The body of the most recent request the mock received. */
function lastBody(): Record<string, unknown> {
  return mock.requests.at(-1) as Record<string, unknown>;
}

describe('the output-token-limit parameter is per-vendor', () => {
  test('openai sends max_completion_tokens — max_tokens is a 400 on every current model', async () => {
    const provider = createOpenAiProvider('openai', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    await provider.generate(request());

    expect(lastBody().max_completion_tokens).toBe(128);
    expect(lastBody().max_tokens).toBeUndefined();
  });

  test('everyone else still speaks max_tokens', async () => {
    for (const make of [
      createGrokProvider,
      createDeepSeekProvider,
      createOpenAiCompatibleProvider,
    ]) {
      const provider = make('p', config(), { apiKey: 'sk-mock', logger: silentLogger });
      await provider.generate(request());

      expect(lastBody().max_tokens).toBe(128);
      expect(lastBody().max_completion_tokens).toBeUndefined();
    }
  });

  test('openai still defaults to a model that exists', async () => {
    const provider = createOpenAiProvider(
      'openai',
      { baseUrl: mock.url },
      { apiKey: 'sk-mock', logger: silentLogger },
    );
    // `gpt-4o-mini` was two generations stale — and, with `max_tokens`, the ONLY
    // thing the preset could still have called.
    expect(provider.defaultModel).toBe('gpt-5.4-mini');
    expect(provider.priceFor!('gpt-5.4-mini')).not.toBeNull();
  });
});

describe('deepseek thinking mode must be switched off EXPLICITLY', () => {
  test('thinking: false sends {type: "disabled"} — omitting it would leave it ON', async () => {
    const provider = createDeepSeekProvider('deepseek', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    await provider.generate(request({ thinking: false }));

    expect(lastBody().thinking).toEqual({ type: 'disabled' });
  });

  test('thinking: true sends {type: "enabled"}', async () => {
    const provider = createDeepSeekProvider('deepseek', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    await provider.generate(request({ thinking: true }));

    expect(lastBody().thinking).toEqual({ type: 'enabled' });
  });

  test('effort maps onto deepseek’s own scale (it takes high|max, not our five)', async () => {
    const provider = createDeepSeekProvider('deepseek', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    await provider.generate(request({ effort: 'low' }));
    expect(lastBody().reasoning_effort).toBe('high'); // low/medium map UP

    await provider.generate(request({ effort: 'max' }));
    expect(lastBody().reasoning_effort).toBe('max');
  });
});

describe('grok reasons unconditionally', () => {
  test('it never sends a thinking toggle — xAI ignores one, so sending it is theatre', async () => {
    const provider = createGrokProvider('grok', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    await provider.generate(request({ thinking: false }));

    // Measured: `thinking: {type:'disabled'}` is accepted and has NO effect (33
    // reasoning tokens anyway), and `reasoning_effort: 'none'` is a hard 400. The
    // orchestrator raises a degradation instead — see capabilities.thinkingAlwaysOn.
    expect(lastBody().thinking).toBeUndefined();
  });

  test('it declares thinkingAlwaysOn, so a caller asking for OFF is told', async () => {
    const provider = createGrokProvider('grok', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    expect(provider.capabilities.thinkingAlwaysOn).toBe(true);
    expect(provider.capabilities.thinking).not.toBe('none'); // it DOES reason
  });

  test('effort maps onto xAI’s scale, which has no "none"', async () => {
    const provider = createGrokProvider('grok', config(), {
      apiKey: 'sk-mock',
      logger: silentLogger,
    });
    await provider.generate(request({ effort: 'medium' }));
    expect(lastBody().reasoning_effort).toBe('low');

    await provider.generate(request({ effort: 'high' }));
    expect(lastBody().reasoning_effort).toBe('high');
  });
});

describe('extraBody — the escape hatch for the backends we cannot enumerate', () => {
  test('config.extraBody is merged into the payload', async () => {
    const provider = createOpenAiCompatibleProvider(
      'ollama',
      config({ extraBody: { top_k: 40, mirostat: 2 } }),
      { apiKey: null, logger: silentLogger },
    );
    await provider.generate(request());

    expect(lastBody().top_k).toBe(40);
    expect(lastBody().mirostat).toBe(2);
  });

  test('it is merged LAST, so it can override what the adapter chose', async () => {
    // An escape hatch you must ask permission from is not an escape hatch. This
    // adapter fronts Ollama/vLLM/LM Studio/OpenRouter/Together — we cannot know
    // their knobs, and the alternative to this seam is an app forking the adapter.
    const provider = createOpenAiCompatibleProvider(
      'vllm',
      config({ extraBody: { max_tokens: 9999 } }),
      { apiKey: null, logger: silentLogger },
    );
    await provider.generate(request({ maxTokens: 128 }));

    expect(lastBody().max_tokens).toBe(9999);
  });
});

describe('deepseek’s mandatory "json" keyword', () => {
  test('jsonInstruction() contains the word — DeepSeek 400s without it', () => {
    const instruction = jsonInstruction('card', { type: 'object' });

    // Verified live: DeepSeek's check is case-insensitive ("in some form"), so the
    // uppercase "JSON" in this string satisfies it. A control prompt with no form
    // of the word returns:
    //   "Prompt must contain the word 'json' in some form to use 'response_format'
    //    of type 'json_object'."
    // If anyone rewrites this instruction without the word, DeepSeek breaks — and
    // it breaks as a 400 on every structured call, not as a subtle regression.
    expect(instruction).toMatch(/json/i);
  });
});
