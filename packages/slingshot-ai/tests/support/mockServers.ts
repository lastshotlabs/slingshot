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

      return new Response(frames.join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

export function startMockOpenAi(options: MockOptions = {}): MockServer {
  const text = options.text ?? 'Hello from the mock.';
  const finishReason = options.stopReason ?? 'stop';
  const requests: Record<string, unknown>[] = [];

  const usage = {
    prompt_tokens: 13,
    completion_tokens: 9,
    prompt_tokens_details: { cached_tokens: 4 },
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push(body);

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
              },
              finish_reason: finishReason,
            },
          ],
          usage,
        });
      }

      const frames: string[] = [];
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

      return new Response(frames.join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}
