/**
 * The OpenAI-compatible adapter — plain `fetch`, ZERO dependencies.
 *
 * This is the highest-leverage adapter in the package, because the
 * `/chat/completions` shape is the de-facto lingua franca: Ollama, LM Studio,
 * llama.cpp, vLLM, OpenRouter, Groq, Together, and Gemini's compat endpoint all
 * speak it. One adapter therefore turns "free local inference on the home
 * server" into a config change.
 *
 * Which is also the design problem. Those backends have wildly different real
 * abilities: vLLM with a grammar backend genuinely enforces a JSON Schema; a
 * small Ollama model cannot reliably close a brace. So capabilities here are
 * **config-declarable**, and the built-in defaults are deliberately pessimistic
 * — an under-declared provider costs you a JSON repair loop, while an
 * over-declared one costs you a card that never validates and a party that
 * stops. Only the wrong one of those is silent.
 */
import type { AiProviderConfig } from '../config';
import { AiConfigError, AiProviderError, AiRateLimitError, AiTimeoutError } from '../errors';
import { resolveCapabilities } from './capabilities';
import { type BuildProviderDeps, registerBuiltinProvider } from './registry';
import type {
  AiProvider,
  AiStopReason,
  ModelPricing,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
  ProviderStream,
  ProviderStreamEvent,
  ProviderUsage,
} from './types';

const KIND = 'openai-compatible';
const OPENAI_KIND = 'openai';

/**
 * The pessimistic baseline, for "some endpoint that speaks /chat/completions".
 *
 * `json-mode` rather than `native`: nearly every server in this family honors
 * `response_format: {type: 'json_object'}` (valid JSON, unenforced shape), while
 * only some support `json_schema` + `strict`. Claiming `native` when the backend
 * ignores it is how you get a silent shape mismatch instead of a repair loop.
 */
const COMPATIBLE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  structuredOutput: 'json-mode',
  promptCaching: 'none',
  streaming: true,
  thinking: 'none',
  effort: false,
  usageAccounting: 'partial',
  // A local model is free, but "free" is a claim about the DEPLOYMENT, not the
  // protocol — so it is not asserted here. Set `pricing: 'free'` in config to
  // get `costUsd: 0`; otherwise cost is honestly `null`.
  costAccounting: false,
  refusalSignal: false,
  toolUse: false,
  maxOutputTokens: 4096,
});

/** OpenAI proper: same wire protocol, genuinely more capable. */
const OPENAI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  ...COMPATIBLE_CAPABILITIES,
  structuredOutput: 'native',
  // OpenAI caches long prefixes on its own; there is no breakpoint to place, so
  // there is also nothing for the orchestrator to degrade.
  promptCaching: 'automatic',
  usageAccounting: 'full',
  costAccounting: true,
  refusalSignal: true,
  toolUse: true,
  maxOutputTokens: 16_384,
});

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Per-million-token prices. Config `providers[x].pricing` overrides this, so a
 * price change never needs a package release — and an unlisted model prices as
 * `null` (unknown), never as a fabricated number.
 */
const OPENAI_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
});

// ---------------------------------------------------------------------------
// Wire types (only the fields we read)
// ---------------------------------------------------------------------------

interface ChatChoice {
  message?: { content?: string | null; refusal?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: ChatUsage;
}

function mapStopReason(choice: ChatChoice | undefined): AiStopReason {
  // A refusal on OpenAI is a populated `message.refusal` with null content —
  // read it BEFORE the content, or an explicit refusal reads as an empty answer.
  if (choice?.message?.refusal) return 'refusal';
  switch (choice?.finish_reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'unknown';
  }
}

function mapUsage(usage: ChatUsage | undefined): ProviderUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    // No server in this family reports cache WRITES separately.
    cacheWriteTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface Preset {
  readonly kind: string;
  readonly baseCapabilities: ProviderCapabilities;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  readonly requiresApiKey: boolean;
}

function createProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
  preset: Preset,
): AiProvider {
  const baseUrl = (config.baseUrl ?? preset.baseUrl)?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new AiConfigError(
      `Provider '${name}' (kind: ${preset.kind}) requires \`baseUrl\` — e.g. ` +
        `'http://localhost:11434/v1' for Ollama, or 'http://localhost:1234/v1' for LM Studio. ` +
        `There is no sensible default for an endpoint we don't host.`,
    );
  }

  const defaultModel = config.defaultModel ?? preset.defaultModel;
  if (!defaultModel) {
    throw new AiConfigError(
      `Provider '${name}' (kind: ${preset.kind}) requires \`defaultModel\`. We cannot guess which ` +
        `model your endpoint serves, and picking one for you would fail at the first request.`,
    );
  }

  if (preset.requiresApiKey && !deps.apiKey) {
    throw new AiConfigError(
      `Provider '${name}' (kind: ${preset.kind}) has no API key. Set \`apiKeySecret\` to the name ` +
        `of a secret in the app's secret store (preferred), or \`apiKey\` directly.`,
    );
  }

  const capabilities = resolveCapabilities(preset.baseCapabilities, config.capabilities);

  function headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      // A local Ollama needs no key; sending an empty Authorization header would
      // make some servers 401.
      ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
      ...(config.headers ?? {}),
    };
  }

  function body(req: NormalizedRequest, stream: boolean): Record<string, unknown> {
    // Every system block collapses into one system message. The `cache` flags
    // are dropped on purpose: this family has no explicit breakpoint concept,
    // and the orchestrator already knows that (capabilities say
    // `promptCaching: 'none' | 'automatic'`), so nothing is being hidden.
    const messages: { role: string; content: string }[] = [];
    const systemText = req.system.map(block => block.text).join('\n\n');
    if (systemText) messages.push({ role: 'system', content: systemText });
    for (const message of req.messages) {
      messages.push({ role: message.role, content: message.content });
    }

    const payload: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };

    if (req.structured?.mode === 'native') {
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.structured.name,
          schema: req.structured.jsonSchema,
          strict: true,
        },
      };
    } else if (req.structured?.mode === 'json-mode') {
      payload.response_format = { type: 'json_object' };
    }
    // mode 'prompt' → nothing: the orchestrator already injected the schema
    // instruction into the system prompt.

    return payload;
  }

  async function post(
    req: NormalizedRequest,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body(req, stream)),
        signal: combined,
      });
    } catch (error) {
      // The caller's own abort wins — that isn't a provider failure.
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new AiTimeoutError(
          `${preset.kind} request to ${baseUrl} exceeded the ${req.timeoutMs}ms timeout.`,
          { timeoutMs: req.timeoutMs, cause: error },
        );
      }
      // DNS failure, connection refused, socket reset — all worth another go.
      // A local model server that isn't up yet lands here.
      throw new AiProviderError(
        `Could not reach ${preset.kind} endpoint at ${baseUrl}: ${(error as Error).message}`,
        { retryable: true, status: null, providerKind: preset.kind, cause: error },
      );
    }

    if (!response.ok) throw await toHttpError(response, preset.kind);
    return response;
  }

  return {
    kind: preset.kind,
    name,
    defaultModel,
    capabilities,

    async generate(req: NormalizedRequest, signal?: AbortSignal): Promise<ProviderResult> {
      const response = await post(req, false, signal);
      const payload = (await response.json()) as ChatResponse;
      const choice = payload.choices?.[0];

      // stop_reason before content, always.
      const stopReason = mapStopReason(choice);
      return {
        text: choice?.message?.content ?? '',
        stopReason,
        usage: mapUsage(payload.usage),
        raw: payload,
      };
    },

    stream(req: NormalizedRequest, signal?: AbortSignal): ProviderStream {
      let final: Promise<ProviderResult> | undefined;
      const events: ProviderStreamEvent[] = [];

      // One pass over the SSE body fills `events` and resolves the result. The
      // iterator replays `events`, so the deltas it yields and the text in the
      // final result are the same bytes by construction.
      async function consume(): Promise<ProviderResult> {
        const response = await post(req, true, signal);
        const reader = response.body?.getReader();
        if (!reader) {
          throw new AiProviderError(`${preset.kind} returned a streaming response with no body.`, {
            retryable: true,
            status: response.status,
            providerKind: preset.kind,
          });
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        let usage: ChatUsage | undefined;
        let lastChoice: ChatChoice | undefined;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line; a chunk can split one.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;

              let chunk: ChatResponse;
              try {
                chunk = JSON.parse(data) as ChatResponse;
              } catch {
                // A keepalive or a partial frame. Skipping is correct; throwing
                // would kill a stream over a comment line.
                continue;
              }

              if (chunk.usage) usage = chunk.usage;
              const choice = chunk.choices?.[0];
              if (!choice) continue;
              lastChoice = choice;

              const delta = choice.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                text += delta;
                events.push({ type: 'text', delta });
              }
            }
          }
        }

        return {
          text,
          stopReason: mapStopReason(lastChoice),
          usage: mapUsage(usage),
          raw: { streamed: true, usage, finishReason: lastChoice?.finish_reason ?? null },
        };
      }

      function start(): Promise<ProviderResult> {
        final ??= consume();
        void final.catch(() => {});
        return final;
      }

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderStreamEvent> {
          await start();
          yield* events;
        },
        finalResult: () => start(),
      };
    },

    priceFor(model: string): ModelPricing | null {
      // `null` for an unknown model is the required answer. A guessed price is
      // how a cost dashboard becomes fiction.
      return preset.pricing?.[model] ?? null;
    },
  };
}

async function toHttpError(response: Response, kind: string): Promise<Error> {
  const detail = await response.text().catch(() => '');
  const message = detail.slice(0, 500) || response.statusText;

  if (response.status === 429) {
    const raw = response.headers.get('retry-after');
    const seconds = raw ? Number(raw) : NaN;
    return new AiRateLimitError(`${kind} rate limited the request: ${message}`, {
      providerKind: kind,
      status: 429,
      retryAfterMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    });
  }

  return new AiProviderError(`${kind} returned ${response.status}: ${message}`, {
    // 4xx will fail the same way every time — a bad schema, a bad key, an
    // unknown model. Only 5xx is worth retrying.
    retryable: response.status >= 500,
    status: response.status,
    providerKind: kind,
  });
}

/** Any endpoint speaking `/chat/completions`. `baseUrl` + `defaultModel` required. */
export function createOpenAiCompatibleProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): AiProvider {
  return createProvider(name, config, deps, {
    kind: KIND,
    baseCapabilities: COMPATIBLE_CAPABILITIES,
    requiresApiKey: false,
  });
}

/** OpenAI proper — the same adapter with the endpoint, capabilities, and prices filled in. */
export function createOpenAiProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): AiProvider {
  return createProvider(name, config, deps, {
    kind: OPENAI_KIND,
    baseCapabilities: OPENAI_CAPABILITIES,
    baseUrl: OPENAI_BASE_URL,
    defaultModel: OPENAI_DEFAULT_MODEL,
    pricing: OPENAI_PRICING,
    requiresApiKey: true,
  });
}

registerBuiltinProvider(KIND, createOpenAiCompatibleProvider);
registerBuiltinProvider(OPENAI_KIND, createOpenAiProvider);
