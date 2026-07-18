/**
 * The Anthropic adapter.
 *
 * A dumb transport (see `types.ts`): it translates one `NormalizedRequest` into
 * one Messages API call and normalizes the response back. It does not validate
 * schemas, price calls, retry, or moderate — the orchestrator does all of that,
 * once, for every provider.
 *
 * Three things in here are not obvious and are load-bearing:
 *
 * 1. **`temperature` / `top_p` / `top_k` are never sent.** They were removed on
 *    Opus 4.8 and the API returns a 400 if you include them. There is no config
 *    knob for them on purpose — one would be a footgun that 400s.
 *
 * 2. **The SDK's own retries are disabled** (`maxRetries: 0`). This package has
 *    exactly one retry layer, and that layer re-enters the spend guard before
 *    every attempt. An SDK that quietly retried underneath us would make real
 *    HTTP calls that the spend guard never saw — which is precisely the runaway
 *    bill the guard exists to prevent.
 *
 * 3. **`stop_reason` is read before the content is.** A refusal arrives as an
 *    HTTP 200 with empty or partial content. Code that reaches for
 *    `content[0].text` first crashes on a refusal instead of reporting one.
 */
import type { AiProviderConfig } from '../config';
import { AiConfigError, AiProviderError, AiRateLimitError, AiTimeoutError } from '../errors';
import { createEventQueue } from '../lib/eventQueue';
import { resolveCapabilities } from './capabilities';
import { registerBuiltinProvider } from './registry';
import type { BuildProviderDeps } from './registry';
import type {
  AiProvider,
  AiStopReason,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
  ProviderStream,
  ProviderStreamEvent,
  ProviderUsage,
} from './types';

const KIND = 'anthropic';

/**
 * Declared honestly. Over-declaring here is the only way to get silently wrong
 * behavior out of this package — if a capability is listed, the orchestrator
 * will rely on it and will NOT record a degradation.
 */
const ANTHROPIC_CAPABILITIES: ProviderCapabilities = Object.freeze({
  structuredOutput: 'native',
  promptCaching: 'explicit',
  // The minimum cacheable prefix on Opus-class models. Below this the API
  // ACCEPTS a `cache_control` breakpoint and then silently does not cache, so
  // the orchestrator needs the number in order to refuse to emit one.
  promptCacheMinTokens: 4096,
  streaming: true,
  thinking: 'adaptive',
  effort: true,
  usageAccounting: 'full',
  costAccounting: true,
  refusalSignal: true,
  imageInput: true,
  toolUse: true,
  maxOutputTokens: 64_000,
});

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Above this, a non-streaming request risks the SDK's long-request guard (and a
 * very long socket hold). We transparently run it over the streaming API and
 * assemble the result, which the caller cannot observe.
 */
const STREAM_ABOVE_MAX_TOKENS = 16_384;

// ---------------------------------------------------------------------------
// Lazy SDK load
// ---------------------------------------------------------------------------

type AnthropicModule = typeof import('@anthropic-ai/sdk');
type AnthropicClient = InstanceType<AnthropicModule['default']>;

/**
 * `@anthropic-ai/sdk` is an OPTIONAL peer. Importing `slingshot-ai` must never
 * pull it into an app that only talks to a local model, so the import happens
 * here — inside the factory, which `buildProvider` awaits at boot.
 *
 * Boot is also the right place to fail: a missing SDK (or a missing key) should
 * stop the server, not surface when the first player taps a button.
 */
async function loadAnthropicModule(): Promise<AnthropicModule> {
  try {
    return await import('@anthropic-ai/sdk');
  } catch (cause) {
    throw new AiConfigError(
      `The 'anthropic' provider requires @anthropic-ai/sdk to be installed. ` +
        `Run: bun add @anthropic-ai/sdk`,
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Error mapping — by SDK error CLASS, most specific first. Never by string.
// ---------------------------------------------------------------------------

function parseRetryAfterMs(headers: unknown): number | null {
  if (!headers || typeof (headers as Headers).get !== 'function') return null;
  const raw = (headers as Headers).get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

function mapError(error: unknown, sdk: AnthropicModule, timeoutMs: number): unknown {
  // The caller aborted. That is not a provider failure — hand it back untouched
  // so `AbortSignal` semantics survive.
  if (error instanceof sdk.APIUserAbortError) return error;

  if (error instanceof sdk.APIConnectionTimeoutError) {
    return new AiTimeoutError(`Anthropic request exceeded the ${timeoutMs}ms timeout.`, {
      timeoutMs,
      cause: error,
    });
  }

  if (error instanceof sdk.RateLimitError) {
    return new AiRateLimitError('Anthropic rate limited the request.', {
      providerKind: KIND,
      status: error.status ?? 429,
      retryAfterMs: parseRetryAfterMs(error.headers),
      cause: error,
    });
  }

  // 4xx that will fail identically on every retry. Retrying a malformed schema
  // or a bad key just spends latency and (for the ones that bill) money.
  if (
    error instanceof sdk.BadRequestError ||
    error instanceof sdk.AuthenticationError ||
    error instanceof sdk.PermissionDeniedError ||
    error instanceof sdk.NotFoundError ||
    error instanceof sdk.UnprocessableEntityError
  ) {
    return new AiProviderError(`Anthropic rejected the request: ${error.message}`, {
      retryable: false,
      status: error.status ?? null,
      providerKind: KIND,
      cause: error,
    });
  }

  if (error instanceof sdk.InternalServerError) {
    return new AiProviderError(`Anthropic server error: ${error.message}`, {
      retryable: true,
      status: error.status ?? null,
      providerKind: KIND,
      cause: error,
    });
  }

  if (error instanceof sdk.APIConnectionError) {
    return new AiProviderError(`Could not reach Anthropic: ${error.message}`, {
      retryable: true,
      status: null,
      providerKind: KIND,
      cause: error,
    });
  }

  if (error instanceof sdk.APIError) {
    const status = error.status ?? null;
    return new AiProviderError(`Anthropic API error: ${error.message}`, {
      // Anything 5xx we haven't named is worth one more go; anything else isn't.
      retryable: status !== null && status >= 500,
      status,
      providerKind: KIND,
      cause: error,
    });
  }

  return error;
}

// ---------------------------------------------------------------------------
// Request / response translation
// ---------------------------------------------------------------------------

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

function buildParams(req: NormalizedRequest): Record<string, unknown> {
  const system: AnthropicSystemBlock[] = req.system.map(block => ({
    type: 'text',
    text: block.text,
    // The orchestrator decides WHERE the breakpoint goes (and whether one is
    // legal at all, given `promptCacheMinTokens`). We just honor the flag.
    ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  const outputConfig: Record<string, unknown> = {};
  if (req.effort) outputConfig.effort = req.effort;
  if (req.structured && req.structured.mode === 'native') {
    // The orchestrator's sanitized JSON Schema, sent as-is. Deliberately NOT
    // `zodOutputFormat()`: that helper re-derives its own schema from the zod
    // type (moving stripped constraints into `description` strings, keeping
    // some keywords ours drops), which would mean the model is shown a
    // different schema than the one the package reports having sent. One
    // schema, one validation point.
    outputConfig.format = { type: 'json_schema', schema: req.structured.jsonSchema };
  }

  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: req.messages.map(message => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map(part =>
              part.type === 'text'
                ? { type: 'text', text: part.text }
                : {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: part.mediaType,
                      data: part.data,
                    },
                  },
            ),
    })),
    ...(req.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    // NOTE: no temperature, no top_p, no top_k. They are removed on Opus 4.8 and
    // sending any of them is a 400.
  };
}

function mapStopReason(raw: string | null | undefined): AiStopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'tool_use':
      return 'tool_use';
    default:
      return 'unknown';
  }
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function mapUsage(usage: AnthropicUsage | undefined): ProviderUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

interface AnthropicMessage {
  content?: readonly { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

/** Collect text blocks defensively — on a refusal there may be none at all. */
function textOf(message: AnthropicMessage): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('');
}

function toResult(message: AnthropicMessage, textOverride?: string): ProviderResult {
  // stop_reason FIRST. A refusal is a 200 with empty/partial content, so any
  // code that reads content before checking this crashes on the one case it
  // most needs to report.
  const stopReason = mapStopReason(message.stop_reason);
  return {
    text: textOverride ?? textOf(message),
    stopReason,
    usage: mapUsage(message.usage),
    raw: message,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export async function createAnthropicProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): Promise<AiProvider> {
  if (!deps.apiKey) {
    throw new AiConfigError(
      `Provider '${name}' (kind: anthropic) has no API key. Set \`apiKeySecret\` to the name of a ` +
        `secret in the app's secret store (preferred), or \`apiKey\` directly.`,
    );
  }

  const sdk = await loadAnthropicModule();
  const Anthropic = sdk.default;

  const client: AnthropicClient = new Anthropic({
    apiKey: deps.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    ...(config.headers ? { defaultHeaders: config.headers } : {}),
    // See the file header: this package owns retries, because only this
    // package's retry layer re-enters the spend guard on every attempt.
    maxRetries: 0,
  });

  const capabilities = resolveCapabilities(ANTHROPIC_CAPABILITIES, config.capabilities);
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;

  /** The SDK object is `any`-ish across versions; keep the cast in one place. */
  const messages = client.messages as unknown as {
    create(params: unknown, options?: unknown): Promise<AnthropicMessage>;
    stream(
      params: unknown,
      options?: unknown,
    ): AsyncIterable<unknown> & {
      finalMessage(): Promise<AnthropicMessage>;
    };
    countTokens(params: unknown, options?: unknown): Promise<{ input_tokens: number }>;
  };

  function streamOf(req: NormalizedRequest, signal?: AbortSignal): ProviderStream {
    const queue = createEventQueue<ProviderStreamEvent>();
    let final: Promise<ProviderResult> | undefined;

    function start(): Promise<ProviderResult> {
      if (final) return final;

      final = (async () => {
        let text = '';
        try {
          const sdkStream = messages.stream(buildParams(req), {
            signal,
            timeout: req.timeoutMs,
          });

          for await (const rawEvent of sdkStream) {
            const event = rawEvent as {
              type?: string;
              delta?: { type?: string; text?: string; thinking?: string };
            };
            if (event.type !== 'content_block_delta' || !event.delta) continue;

            if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
              text += event.delta.text;
              queue.push({ type: 'text', delta: event.delta.text });
            } else if (
              event.delta.type === 'thinking_delta' &&
              typeof event.delta.thinking === 'string'
            ) {
              queue.push({ type: 'thinking', delta: event.delta.thinking });
            }
          }

          const message = await sdkStream.finalMessage();
          queue.finish();
          // `text` is the concatenation of exactly the deltas we emitted, so the
          // conformance invariant (deltas === finalResult().text) holds by
          // construction rather than by coincidence. A UI showing the stream and
          // a row storing the answer cannot disagree.
          return toResult(message, text);
        } catch (error) {
          const mapped = mapError(error, sdk, req.timeoutMs);
          queue.fail(mapped);
          throw mapped;
        }
      })();

      // The iterator surfaces the same failure. Mark the promise handled so a
      // caller who only iterates doesn't trip an unhandled rejection.
      void final.catch(() => {});
      return final;
    }

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<ProviderStreamEvent> {
        start();
        yield* queue.drain();
      },
      finalResult: () => start(),
    };
  }

  return {
    kind: KIND,
    name,
    defaultModel,
    capabilities,

    async generate(req: NormalizedRequest, signal?: AbortSignal): Promise<ProviderResult> {
      // A very large max_tokens on the non-streaming endpoint holds a socket open
      // long enough to trip the SDK's own long-request guard. Route it through
      // the streaming API and assemble — invisible to the caller.
      if (req.maxTokens > STREAM_ABOVE_MAX_TOKENS) {
        return streamOf(req, signal).finalResult();
      }

      try {
        const message = await messages.create(buildParams(req), {
          signal,
          timeout: req.timeoutMs,
        });
        return toResult(message);
      } catch (error) {
        throw mapError(error, sdk, req.timeoutMs);
      }
    },

    stream: streamOf,

    async countTokens(req: NormalizedRequest): Promise<number> {
      const params = buildParams(req) as Record<string, unknown>;
      // countTokens has no notion of an output budget or an output format.
      delete params.max_tokens;
      delete params.output_config;
      const counted = await messages.countTokens(params, { timeout: req.timeoutMs });
      return counted.input_tokens;
    },
  };
}

registerBuiltinProvider(KIND, createAnthropicProvider);
