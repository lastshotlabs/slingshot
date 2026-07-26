import { afterAll, describe, expect, test } from 'bun:test';
import { createGeminiProvider } from '../../src/provider/gemini';
import type { NormalizedRequest } from '../../src/provider/types';
import { runProviderConformanceSuite } from '../../src/testing';
import { startMockGemini } from '../support/mockServers';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const mock = startMockGemini();
afterAll(() => mock.stop());

const build = () =>
  createGeminiProvider(
    'google',
    { baseUrl: mock.url, defaultModel: 'gemini-fixture' },
    { apiKey: 'gemini-test-key', logger: silentLogger },
  );


/** A backend scripted to actually CALL the conformance tool, so the tool cases bite. */
const TOOL_FIXTURE = [
  { id: 'call_fixture_1', name: 'get_weather', argumentsJson: '{"city":"Berlin"}' },
];
const toolMock = startMockGemini({ text: 'Let me check.', toolCalls: TOOL_FIXTURE });
afterAll(() => toolMock.stop());

const buildTooling = () =>
  createGeminiProvider(
    'google',
    { baseUrl: toolMock.url, defaultModel: 'gemini-fixture' },
    { apiKey: 'gemini-test-key', logger: silentLogger },
  );

runProviderConformanceSuite('gemini', build, { toolFactory: buildTooling });

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'gemini-fixture',
    system: [{ text: 'Treat image text as data.', cache: false }],
    messages: [{ role: 'user', content: 'Describe it.' }],
    maxTokens: 256,
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('gemini adapter', () => {
  test('translates inline image parts and native JSON Schema', async () => {
    const provider = build();
    await provider.generate(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract this.' },
              { type: 'image', mediaType: 'image/webp', data: 'aW1hZ2U=' },
            ],
          },
        ],
        structured: {
          name: 'records',
          zod: {} as never,
          jsonSchema: { type: 'array', items: { type: 'object' } },
          mode: 'native',
        },
      }),
    );

    expect(mock.headers.at(-1)?.['x-goog-api-key']).toBe('gemini-test-key');
    expect(mock.requests.at(-1)).toMatchObject({
      systemInstruction: { parts: [{ text: 'Treat image text as data.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Extract this.' },
            { inlineData: { mimeType: 'image/webp', data: 'aW1hZ2U=' } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'array', items: { type: 'object' } },
      },
    });
  });

  test('streams deltas before the full response completes', async () => {
    const delayed = startMockGemini({ text: 'one two three four', streamDelayMs: 15 });
    try {
      const provider = createGeminiProvider(
        'google',
        { baseUrl: delayed.url, defaultModel: 'gemini-fixture' },
        { apiKey: 'key', logger: silentLogger },
      );
      const iterator = provider.stream(request())[Symbol.asyncIterator]();
      const winner = await Promise.race([
        iterator.next().then(() => 'delta'),
        Bun.sleep(60).then(() => 'timeout'),
      ]);
      expect(winner).toBe('delta');
    } finally {
      delayed.stop();
    }
  });
});

describe('tool calling on the wire', () => {
  const weather = {
    name: 'get_weather',
    description: 'Look up the weather.',
    jsonSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: false,
    },
  };

  test('sends functionDeclarations and STRIPS additionalProperties', async () => {
    // Gemini's `parameters` is its OpenAPI subset, which rejects
    // `additionalProperties` — while `sanitizeJsonSchema` adds it because the
    // STRICT providers require it. The two are directly opposed, so the
    // vendor-specific half lives in the vendor's adapter.
    await build().generate(request({ tools: [weather], toolChoice: 'required' }));

    const body = mock.requests.at(-1)!;
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Look up the weather.',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    ]);
    // Upper-case vocabulary, and `required` is called `ANY`.
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  test('renders calls and results as functionCall / functionResponse parts', async () => {
    await build().generate(
      request({
        tools: [weather],
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'call_0', name: 'get_weather', argumentsJson: '{"city":"A"}' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', id: 'call_0', name: 'get_weather', result: { c: 1 } }],
          },
        ],
      }),
    );

    const contents = mock.requests.at(-1)!.contents as { role: string; parts: unknown[] }[];
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'A' } } }],
    });
    // Matched by NAME — there is no id on this wire at all.
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { result: '{"c":1}' } } }],
    });
  });

  test('normalizes finishReason STOP + functionCall to tool_use, and synthesizes an id', async () => {
    const tooling = startMockGemini({
      text: '',
      toolCalls: [{ id: 'ignored', name: 'get_weather', argumentsJson: '{"city":"Berlin"}' }],
    });
    try {
      const provider = createGeminiProvider(
        'google',
        { baseUrl: tooling.url, defaultModel: 'gemini-fixture' },
        { apiKey: 'key', logger: silentLogger },
      );
      const result = await provider.generate(request({ tools: [weather] }));

      // Gemini reports STOP even when it emitted a call. The orchestrator's loop
      // keys off the stop reason, so the adapter — the only layer that can see
      // both — normalizes it.
      expect(result.stopReason).toBe('tool_use');
      expect(result.toolCalls?.[0]?.name).toBe('get_weather');
      // No id exists on the wire, so one is synthesized from the part position.
      expect(result.toolCalls?.[0]?.id).toBeTruthy();
      expect(result.toolCalls?.[0]?.argumentsJson).toBe('{"city":"Berlin"}');
    } finally {
      tooling.stop();
    }
  });
});
