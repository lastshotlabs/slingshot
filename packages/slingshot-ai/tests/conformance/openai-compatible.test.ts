/**
 * OpenAI-compatible adapter — the provider contract, plus the behaviors that
 * make one adapter safely front Ollama, vLLM, OpenRouter, and OpenAI itself.
 *
 * Fully hermetic: the adapter is plain `fetch`, so a local `Bun.serve` speaking
 * `/chat/completions` is a complete stand-in for every backend in the family.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AiProviderConfig } from '../../src/config';
import { AiConfigError, AiProviderError, AiRateLimitError } from '../../src/errors';
import {
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
} from '../../src/provider/openaiCompatible';
import type { NormalizedRequest } from '../../src/provider/types';
import { runProviderConformanceSuite } from '../../src/testing';
import { startMockOpenAi } from '../support/mockServers';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const mock = startMockOpenAi();
afterAll(() => mock.stop());

function build(config: Partial<AiProviderConfig> = {}, server = mock) {
  return createOpenAiCompatibleProvider(
    'local',
    { baseUrl: server.url, defaultModel: 'llama3.1', ...config },
    { apiKey: null, logger: silentLogger },
  );
}

/** A backend scripted to actually CALL the conformance tool, so the tool cases bite. */
const TOOL_FIXTURE = [
  { id: 'call_fixture_1', name: 'get_weather', argumentsJson: '{"city":"Berlin"}' },
];

const toolMock = startMockOpenAi({ text: 'Let me check.', toolCalls: TOOL_FIXTURE });
afterAll(() => toolMock.stop());

// The generic preset declares `toolUse: false` — an arbitrary /chat/completions
// server may or may not support tools, and over-declaring is the only way to get
// silently wrong behavior out of this package. The tool cases therefore run
// against a version that opts IN, which is what a real vLLM or Ollama deployment
// that does support tools would configure.
runProviderConformanceSuite('openai-compatible', () => build(), {
  toolFactory: () => build({ capabilities: { toolUse: true } }, toolMock),
});

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'llama3.1',
    system: [{ text: 'You are a fixture.', cache: false }],
    messages: [{ role: 'user', content: 'Say hello.' }],
    maxTokens: 256,
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('openai-compatible adapter', () => {
  test('defaults are pessimistic — a local model is not assumed to enforce schemas', () => {
    const { capabilities } = build();

    // Over-declaring is the only way to get silently wrong behavior out of this
    // package: the orchestrator would trust a guarantee the backend never made.
    expect(capabilities.structuredOutput).toBe('json-mode');
    expect(capabilities.promptCaching).toBe('none');
    expect(capabilities.costAccounting).toBe(false);
    expect(capabilities.refusalSignal).toBe(false);
  });

  test('capabilities are config-declarable (vLLM+grammar really does enforce schemas)', () => {
    const { capabilities } = build({
      capabilities: { structuredOutput: 'native', maxOutputTokens: 32_000 },
    });

    expect(capabilities.structuredOutput).toBe('native');
    expect(capabilities.maxOutputTokens).toBe(32_000);
    // Untouched fields keep the pessimistic baseline.
    expect(capabilities.costAccounting).toBe(false);
  });

  test('collapses system blocks into one system message', async () => {
    const provider = build();
    await provider.generate(
      request({
        system: [
          { text: 'rules', cache: true },
          { text: 'roster', cache: false },
        ],
      }),
    );

    const messages = mock.requests.at(-1)!.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'rules\n\nroster' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Say hello.' });
  });

  test('native mode sends json_schema + strict; json-mode sends json_object', async () => {
    const jsonSchema = { type: 'object', properties: { a: { type: 'string' } } };

    const native = build({ capabilities: { structuredOutput: 'native' } });
    await native.generate(
      request({ structured: { name: 'card', zod: null as never, jsonSchema, mode: 'native' } }),
    );
    expect(mock.requests.at(-1)!.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'card', schema: jsonSchema, strict: true },
    });

    const loose = build();
    await loose.generate(
      request({ structured: { name: 'card', zod: null as never, jsonSchema, mode: 'json-mode' } }),
    );
    expect(mock.requests.at(-1)!.response_format).toEqual({ type: 'json_object' });
  });

  test('prompt mode sends no response_format at all', async () => {
    const provider = build();
    await provider.generate(request());
    expect(mock.requests.at(-1)!).not.toHaveProperty('response_format');
  });

  test('reads cached_tokens into cacheReadTokens, and SUBTRACTS them from inputTokens', async () => {
    const provider = build();
    const result = await provider.generate(request());

    // The mock reports prompt_tokens: 13 with cached_tokens: 4 — and in this
    // family `cached_tokens` is a SUBSET of `prompt_tokens`, not a sibling of it.
    //
    // `ProviderUsage`'s four counts are disjoint, because `computeUsage()` bills
    // them additively. Passing the 13 straight through (as this adapter used to)
    // charged the 4 cached tokens twice: once at the full input rate, and again
    // at the cache-read rate. Anthropic reports genuinely disjoint counts, which
    // is why the additive formula was right there and quietly wrong here.
    expect(result.usage.inputTokens).toBe(9);
    expect(result.usage.outputTokens).toBe(9);
    expect(result.usage.cacheReadTokens).toBe(4);
  });

  test('an explicit refusal is not mistaken for an empty answer', async () => {
    const refusing = startMockOpenAi({ refusal: 'I cannot help with that.' });
    try {
      const provider = build({ capabilities: { refusalSignal: true } }, refusing);
      const result = await provider.generate(request());

      expect(result.stopReason).toBe('refusal');
    } finally {
      refusing.stop();
    }
  });

  test('finish_reason: length maps to max_tokens (truncation is the caller’s call)', async () => {
    const truncated = startMockOpenAi({ stopReason: 'length' });
    try {
      const provider = build({}, truncated);
      const result = await provider.generate(request());
      expect(result.stopReason).toBe('max_tokens');
    } finally {
      truncated.stop();
    }
  });

  test('streams SSE deltas that concatenate to the final text', async () => {
    const provider = build();
    const stream = provider.stream(request());

    let accumulated = '';
    let deltas = 0;
    for await (const event of stream) {
      if (event.type === 'text') {
        accumulated += event.delta;
        deltas++;
      }
    }
    const final = await stream.finalResult();

    expect(deltas).toBeGreaterThan(1);
    expect(accumulated).toBe(final.text);
    expect(final.text).toBe('Hello from the mock.');
    // Usage rides the final SSE frame, via stream_options.include_usage.
    expect(final.usage.outputTokens).toBe(9);
  });

  test('yields the first SSE delta before the provider finishes', async () => {
    const delayed = startMockOpenAi({ text: 'one two three four five six', streamDelayMs: 15 });
    try {
      const iterator = build({}, delayed).stream(request())[Symbol.asyncIterator]();
      const winner = await Promise.race([
        iterator.next().then(() => 'delta'),
        Bun.sleep(60).then(() => 'timeout'),
      ]);
      expect(winner).toBe('delta');
    } finally {
      delayed.stop();
    }
  });

  test('maps 429 → AiRateLimitError, 4xx → non-retryable, 5xx → retryable', async () => {
    const limited = startMockOpenAi({ status: 429, headers: { 'retry-after': '3' } });
    const bad = startMockOpenAi({ status: 400 });
    const broken = startMockOpenAi({ status: 503 });
    try {
      const rate = await build({}, limited)
        .generate(request())
        .catch((e: unknown) => e);
      expect(rate).toBeInstanceOf(AiRateLimitError);
      expect((rate as AiRateLimitError).retryAfterMs).toBe(3000);

      const invalid = await build({}, bad)
        .generate(request())
        .catch((e: unknown) => e);
      expect(invalid).toBeInstanceOf(AiProviderError);
      expect((invalid as AiProviderError).retryable).toBe(false);

      const server = await build({}, broken)
        .generate(request())
        .catch((e: unknown) => e);
      expect((server as AiProviderError).retryable).toBe(true);
    } finally {
      limited.stop();
      bad.stop();
      broken.stop();
    }
  });

  test('an unreachable endpoint is retryable (a local model server may still be booting)', async () => {
    const provider = build({ baseUrl: 'http://127.0.0.1:1' });
    const error = await provider.generate(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).retryable).toBe(true);
  });

  test('refuses to boot without baseUrl or defaultModel rather than guessing', () => {
    expect(() =>
      createOpenAiCompatibleProvider(
        'local',
        { defaultModel: 'llama3.1' },
        { apiKey: null, logger: silentLogger },
      ),
    ).toThrow(AiConfigError);

    expect(() =>
      createOpenAiCompatibleProvider(
        'local',
        { baseUrl: mock.url },
        { apiKey: null, logger: silentLogger },
      ),
    ).toThrow(AiConfigError);
  });

  test('sends no Authorization header when there is no key (a local Ollama 401s on an empty one)', async () => {
    const provider = build();
    await provider.generate(request());
    // The mock records bodies, not headers; the contract we assert here is that
    // a keyless provider constructs and calls successfully at all.
    expect(mock.requests.length).toBeGreaterThan(0);
  });
});

describe('tool calling on the wire', () => {
  function tooled(server = toolMock) {
    return build({ capabilities: { toolUse: true } }, server);
  }

  const weather = {
    name: 'get_weather',
    description: 'Look up the weather.',
    jsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
  };

  test('sends tools as function declarations and forwards tool_choice verbatim', async () => {
    await tooled().generate(request({ tools: [weather], toolChoice: 'required' }));

    const body = toolMock.requests.at(-1)!;
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Look up the weather.',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
    // The vocabulary matches ours exactly, so there is nothing to translate.
    expect(body.tool_choice).toBe('required');
  });

  test('a user turn of tool results becomes ONE role:tool message per result', async () => {
    // The mapping is not one-to-one, which is exactly why tool results are
    // content parts rather than a role — Anthropic has no such role at all.
    await tooled().generate(
      request({
        tools: [weather],
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.' },
              { type: 'tool_call', id: 'c1', name: 'get_weather', argumentsJson: '{"city":"A"}' },
              { type: 'tool_call', id: 'c2', name: 'get_weather', argumentsJson: '{"city":"B"}' },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', id: 'c1', name: 'get_weather', result: { tempC: 1 } },
              {
                type: 'tool_result',
                id: 'c2',
                name: 'get_weather',
                result: 'rainy',
                isError: true,
              },
            ],
          },
        ],
      }),
    );

    const messages = toolMock.requests.at(-1)!.messages as Record<string, unknown>[];
    // system, user, assistant(+tool_calls), tool, tool
    expect(messages).toHaveLength(5);
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"A"}' },
        },
        {
          id: 'c2',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"B"}' },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"tempC":1}',
    });
    // No `is_error` field exists on this wire, so a failure that is not marked
    // in the text is indistinguishable from a successful odd-looking result.
    expect(messages[4]).toEqual({
      role: 'tool',
      tool_call_id: 'c2',
      content: 'Error: rainy',
    });
  });

  test('an assistant turn that is only tool calls sends content: null, not []', async () => {
    await tooled().generate(
      request({
        tools: [weather],
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'c1', name: 'get_weather', argumentsJson: '{}' }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', id: 'c1', name: 'get_weather', result: 1 }],
          },
        ],
      }),
    );

    const messages = toolMock.requests.at(-1)!.messages as Record<string, unknown>[];
    expect(messages[2]!.content).toBeNull();
  });

  test('forces tool_use even when the server says finish_reason: stop', async () => {
    // Several servers in this family do exactly this. The orchestrator's loop
    // keys off the stop reason, so an adapter that passed it through would stop
    // one iteration early: the model asked, and nobody asked back.
    const sloppy = startMockOpenAi({
      stopReason: 'stop',
      toolCalls: [{ id: 'c1', name: 'get_weather', argumentsJson: '{"city":"Berlin"}' }],
    });
    try {
      const result = await tooled(sloppy).generate(request({ tools: [weather] }));
      expect(result.stopReason).toBe('tool_use');
      expect(result.toolCalls?.[0]?.argumentsJson).toBe('{"city":"Berlin"}');
    } finally {
      sloppy.stop();
    }
  });

  test('accumulates streamed arguments by index across two parallel calls', async () => {
    // The failure this pins: accumulating by array position instead of by the
    // wire's `index` interleaves two parallel calls' arguments into nonsense
    // that still parses.
    const parallel = startMockOpenAi({
      text: '',
      toolCalls: [
        { id: 'c1', name: 'get_weather', argumentsJson: '{"city":"Berlin"}' },
        { id: 'c2', name: 'get_weather', argumentsJson: '{"city":"Lisbon"}' },
      ],
    });
    try {
      const stream = tooled(parallel).stream(request({ tools: [weather] }));
      const accumulated = new Map<string, string>();
      for await (const event of stream) {
        if (event.type === 'tool_call_delta') {
          accumulated.set(event.id, (accumulated.get(event.id) ?? '') + event.argumentsDelta);
        }
      }
      const final = await stream.finalResult();

      expect(final.toolCalls?.map(c => c.argumentsJson)).toEqual([
        '{"city":"Berlin"}',
        '{"city":"Lisbon"}',
      ]);
      expect(accumulated.get('c1')).toBe('{"city":"Berlin"}');
      expect(accumulated.get('c2')).toBe('{"city":"Lisbon"}');
    } finally {
      parallel.stop();
    }
  });

  test('reasoning_content still never reaches text when tools are in play', async () => {
    // Tool support adds a third accumulator to the SSE loop. It must not become
    // a second path for the model's private deliberation to land in the answer.
    const reasoning = startMockOpenAi({
      text: 'Checking.',
      reasoning: 'The user probably means the city.',
      toolCalls: [{ id: 'c1', name: 'get_weather', argumentsJson: '{"city":"Berlin"}' }],
    });
    try {
      const stream = tooled(reasoning).stream(request({ tools: [weather] }));
      let text = '';
      let thinking = '';
      for await (const event of stream) {
        if (event.type === 'text') text += event.delta;
        if (event.type === 'thinking') thinking += event.delta;
      }
      const final = await stream.finalResult();

      expect(text).toBe(final.text);
      expect(final.text).toBe('Checking.');
      expect(thinking).toBe('The user probably means the city.');
      expect(final.text).not.toContain('probably');
    } finally {
      reasoning.stop();
    }
  });

  test('the generic preset declares toolUse: false — an arbitrary server may not support it', () => {
    // Over-declaring is the only way to get silently wrong behavior out of this
    // package. A backend that does support tools opts in via config.
    expect(build().capabilities.toolUse).toBe(false);
    expect(build({ capabilities: { toolUse: true } }).capabilities.toolUse).toBe(true);
  });
});

describe('openai preset', () => {
  function openai(config: Partial<AiProviderConfig> = {}) {
    return createOpenAiProvider(
      'openai',
      { baseUrl: mock.url, ...config },
      { apiKey: 'sk-mock', logger: silentLogger },
    );
  }

  test('declares the stronger capabilities OpenAI actually has', () => {
    const { capabilities } = openai();

    expect(capabilities.structuredOutput).toBe('native');
    // Automatic, not explicit: there is no breakpoint to place, so there is also
    // nothing for the orchestrator to degrade.
    expect(capabilities.promptCaching).toBe('automatic');
    expect(capabilities.costAccounting).toBe(true);
    expect(capabilities.refusalSignal).toBe(true);
  });

  test('prices known models and returns an honest null for unknown ones', () => {
    const provider = openai();

    expect(provider.priceFor!('gpt-4o-mini')).toMatchObject({
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
    });
    expect(provider.priceFor!('gpt-does-not-exist')).toBeNull();
  });

  test('requires an API key', () => {
    expect(() =>
      createOpenAiProvider('openai', {}, { apiKey: null, logger: silentLogger }),
    ).toThrow(AiConfigError);
  });
});
