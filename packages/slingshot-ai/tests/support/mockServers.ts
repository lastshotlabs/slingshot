/**
 * Mock provider endpoints.
 *
 * Both adapters are pointed at a local `Bun.serve` rather than the real API, so
 * the conformance suite runs on every machine with no key, no network, and no
 * cost. That is the payoff of adapters that take a `baseUrl`: the contract they
 * must satisfy is testable without the vendor.
 *
 * These servers speak the real wire formats — including Anthropic's SSE event
 * sequence — because a mock that speaks a simplified dialect would pass a suite
 * the real endpoint fails.
 */
export interface MockServer {
  readonly url: string;
  /** Bodies received, in order. Assert against them. */
  readonly requests: Record<string, unknown>[];
  /** Request headers, in order, lowercased. Assert against them. */
  readonly headers: Record<string, string>[];
  stop(): void;
}

export interface MockOptions {
  /** The assistant text to return. Streamed in several deltas. */
  readonly text?: string;
  /** Force a status code (for the error-mapping tests). */
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Anthropic `stop_reason` / OpenAI `finish_reason`. */
  readonly stopReason?: string;
  /** OpenAI-only: populate `message.refusal`. */
  readonly refusal?: string;
  /** Delay between streamed frames; used to prove deltas are not buffered. */
  readonly streamDelayMs?: number;
}

/** Chunk text the way a real stream would — several deltas, not one. */
function chunk(text: string): string[] {
  if (!text) return [];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 5) parts.push(text.slice(i, i + 5));
  return parts;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export function startMockAnthropic(options: MockOptions = {}): MockServer {
  const text = options.text ?? 'Hello from the mock.';
  const stopReason = options.stopReason ?? 'end_turn';
  const requests: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];

  const message = (content: string) => ({
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: content ? [{ type: 'text', text: content }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
    },
  });

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push(body);
      headers.push(Object.fromEntries(request.headers.entries()));

      if (options.status && options.status >= 400) {
        return new Response(JSON.stringify({ type: 'error', error: { message: 'mock failure' } }), {
          status: options.status,
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        });
      }

      if (url.pathname.endsWith('/count_tokens')) {
        return Response.json({ input_tokens: 42 });
      }

      if (body.stream !== true) {
        return Response.json(message(text));
      }

      // The real SSE event sequence. `messages.stream()` assembles
      // `finalMessage()` from exactly these frames.
      const frames: string[] = [];
      const push = (event: string, data: unknown): void => {
        frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      push('message_start', {
        type: 'message_start',
        message: {
          ...message(''),
          usage: {
            input_tokens: 11,
            output_tokens: 0,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 5,
          },
        },
      });
      push('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      for (const delta of chunk(text)) {
        push('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta },
        });
      }
      push('content_block_stop', { type: 'content_block_stop', index: 0 });
      push('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 7 },
      });
      push('message_stop', { type: 'message_stop' });

      const responseBody = options.streamDelayMs
        ? new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
                await Bun.sleep(options.streamDelayMs!);
              }
              controller.close();
            },
          })
        : frames.join('');
      return new Response(responseBody, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    headers,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export function startMockGemini(options: MockOptions = {}): MockServer {
  const text = options.text ?? 'Hello from Gemini.';
  const finishReason = options.stopReason ?? 'STOP';
  const requests: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const usageMetadata = { promptTokenCount: 13, candidatesTokenCount: 9 };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push(body);
      headers.push(Object.fromEntries(request.headers.entries()));

      if (options.status && options.status >= 400) {
        return new Response(JSON.stringify({ error: { message: 'mock failure' } }), {
          status: options.status,
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        });
      }

      const payload = (delta: string, final = false) => ({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: delta }] },
            ...(final ? { finishReason } : {}),
          },
        ],
        ...(final ? { usageMetadata } : {}),
      });

      if (!url.pathname.endsWith(':streamGenerateContent')) {
        return Response.json(payload(text, true));
      }

      const frames = [...chunk(text).map(delta => `data: ${JSON.stringify(payload(delta))}\n\n`)];
      frames.push(`data: ${JSON.stringify(payload('', true))}\n\n`);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) {
            controller.enqueue(encoder.encode(frame));
            if (options.streamDelayMs) await Bun.sleep(options.streamDelayMs);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    headers,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (also fronts the grok + deepseek presets)
// ---------------------------------------------------------------------------

export interface OpenAiMockOptions extends MockOptions {
  /**
   * Which vendor's usage dialect to speak.
   *
   * - `openai` — `prompt_tokens` TOTAL + `prompt_tokens_details.cached_tokens`
   *   as a SUBSET of it. Also what xAI speaks.
   * - `deepseek` — a DISJOINT `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
   *   split at the top level of `usage`, with no `prompt_tokens_details` at all.
   *
   * The two are not interchangeable, and an adapter that assumes one while
   * talking to the other silently mis-bills. That is the whole reason this option
   * exists rather than one blessed shape.
   */
  readonly usageDialect?: 'openai' | 'deepseek';
  /** DeepSeek thinking mode: emitted alongside `content`, never inside it. */
  readonly reasoning?: string;
  /**
   * Return this `usage` block verbatim, overriding the dialect presets.
   *
   * Exists so a test can pin a REAL payload captured from a live vendor rather
   * than a shape we invented. The vendors disagree about what a token count
   * means, so a fixture we made up would only prove our own assumptions back to
   * us.
   */
  readonly usage?: Record<string, unknown>;
}

/** OpenAI/xAI: `cached_tokens` ⊆ `prompt_tokens`. 13 total, 4 of them cached. */
const OPENAI_USAGE = {
  prompt_tokens: 13,
  completion_tokens: 9,
  prompt_tokens_details: { cached_tokens: 4 },
};

/** DeepSeek: disjoint, and they sum to `prompt_tokens`. Same 13 = 9 + 4. */
const DEEPSEEK_USAGE = {
  prompt_tokens: 13,
  completion_tokens: 9,
  prompt_cache_hit_tokens: 4,
  prompt_cache_miss_tokens: 9,
};

export function startMockOpenAi(options: OpenAiMockOptions = {}): MockServer {
  const text = options.text ?? 'Hello from the mock.';
  const finishReason = options.stopReason ?? 'stop';
  const requests: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];

  const usage =
    options.usage ?? (options.usageDialect === 'deepseek' ? DEEPSEEK_USAGE : OPENAI_USAGE);

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push(body);
      headers.push(Object.fromEntries(request.headers.entries()));

      if (options.status && options.status >= 400) {
        return new Response(JSON.stringify({ error: { message: 'mock failure' } }), {
          status: options.status,
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        });
      }

      if (body.stream !== true) {
        return Response.json({
          id: 'chatcmpl-mock',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: options.refusal ? null : text,
                refusal: options.refusal ?? null,
                ...(options.reasoning ? { reasoning_content: options.reasoning } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage,
        });
      }

      const frames: string[] = [];
      // Reasoning streams FIRST, in its own field — exactly as DeepSeek does it.
      for (const delta of chunk(options.reasoning ?? '')) {
        frames.push(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
          })}\n\n`,
        );
      }
      for (const delta of chunk(text)) {
        frames.push(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`,
        );
      }
      frames.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage,
        })}\n\n`,
      );
      frames.push('data: [DONE]\n\n');

      const responseBody = options.streamDelayMs
        ? new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
                await Bun.sleep(options.streamDelayMs!);
              }
              controller.close();
            },
          })
        : frames.join('');
      return new Response(responseBody, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}/v1`,
    requests,
    headers,
    stop: () => server.stop(true),
  };
}
