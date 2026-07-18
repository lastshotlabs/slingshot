/** Google Gemini GenerateContent transport (REST, no SDK dependency). */
import type { AiProviderConfig } from '../config';
import { AiConfigError, AiProviderError, AiRateLimitError, AiTimeoutError } from '../errors';
import { createEventQueue } from '../lib/eventQueue';
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

const KIND = 'gemini';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash';

const GEMINI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  structuredOutput: 'native',
  promptCaching: 'none',
  streaming: true,
  thinking: 'none',
  effort: false,
  usageAccounting: 'partial',
  costAccounting: true,
  refusalSignal: true,
  imageInput: true,
  toolUse: false,
  maxOutputTokens: 65_536,
});

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsage;
}

function mapStopReason(reason: string | undefined): AiStopReason {
  switch (reason) {
    case 'STOP':
      return 'end';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'refusal';
    default:
      return 'unknown';
  }
}

function mapUsage(usage: GeminiUsage | undefined): ProviderUsage {
  const cached = usage?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cached),
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function textOf(payload: GeminiResponse): string {
  return (
    payload.candidates?.[0]?.content?.parts
      ?.map(part => (typeof part.text === 'string' ? part.text : ''))
      .join('') ?? ''
  );
}

function requestBody(req: NormalizedRequest): Record<string, unknown> {
  const system = req.system.map(block => block.text).join('\n\n');
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: req.messages.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts:
        typeof message.content === 'string'
          ? [{ text: message.content }]
          : message.content.map(part =>
              part.type === 'text'
                ? { text: part.text }
                : { inlineData: { mimeType: part.mediaType, data: part.data } },
            ),
    })),
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      ...(req.structured
        ? {
            responseMimeType: 'application/json',
            responseJsonSchema: req.structured.jsonSchema,
          }
        : {}),
    },
  };
}

async function httpError(response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 500) || response.statusText;
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    return new AiRateLimitError(`Gemini rate limited the request: ${detail}`, {
      providerKind: KIND,
      status: 429,
      retryAfterMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    });
  }
  return new AiProviderError(`Gemini returned ${response.status}: ${detail}`, {
    retryable: response.status >= 500,
    status: response.status,
    providerKind: KIND,
  });
}

export function createGeminiProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): AiProvider {
  if (!deps.apiKey) {
    throw new AiConfigError(
      `Provider '${name}' (kind: gemini) has no API key. Set \`apiKeySecret\` to the name of a ` +
        `secret in the app's secret store (preferred), or \`apiKey\` directly.`,
    );
  }

  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const capabilities = resolveCapabilities(
    {
      ...GEMINI_CAPABILITIES,
      costAccounting: config.pricing !== undefined,
    },
    config.capabilities,
  );

  async function post(
    req: NormalizedRequest,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    try {
      const response = await fetch(`${baseUrl}/models/${encodeURIComponent(req.model)}:${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': deps.apiKey!,
          ...(config.headers ?? {}),
        },
        body: JSON.stringify(requestBody(req)),
        signal: combined,
      });
      if (!response.ok) throw await httpError(response);
      return response;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new AiTimeoutError(`Gemini request exceeded the ${req.timeoutMs}ms timeout.`, {
          timeoutMs: req.timeoutMs,
          cause: error,
        });
      }
      throw error;
    }
  }

  return {
    kind: KIND,
    name,
    defaultModel,
    capabilities,

    async generate(req, signal): Promise<ProviderResult> {
      const response = await post(req, false, signal);
      const payload = (await response.json()) as GeminiResponse;
      return {
        text: textOf(payload),
        stopReason: mapStopReason(payload.candidates?.[0]?.finishReason),
        usage: mapUsage(payload.usageMetadata),
        raw: payload,
      };
    },

    stream(req, signal): ProviderStream {
      const queue = createEventQueue<ProviderStreamEvent>();
      let final: Promise<ProviderResult> | undefined;

      async function consume(): Promise<ProviderResult> {
        const response = await post(req, true, signal);
        if (!response.body) {
          throw new AiProviderError('Gemini returned a streaming response with no body.', {
            retryable: true,
            status: response.status,
            providerKind: KIND,
          });
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        let usage: GeminiUsage | undefined;
        let finishReason: string | undefined;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw) continue;
              const payload = JSON.parse(raw) as GeminiResponse;
              const delta = textOf(payload);
              if (delta) {
                text += delta;
                queue.push({ type: 'text', delta });
              }
              if (payload.usageMetadata) usage = payload.usageMetadata;
              if (payload.candidates?.[0]?.finishReason) {
                finishReason = payload.candidates[0].finishReason;
              }
            }
          }
        }
        queue.finish();
        return {
          text,
          stopReason: mapStopReason(finishReason),
          usage: mapUsage(usage),
          raw: { streamed: true, usage, finishReason },
        };
      }

      function start(): Promise<ProviderResult> {
        final ??= consume().catch(error => {
          queue.fail(error);
          throw error;
        });
        void final.catch(() => {});
        return final;
      }

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderStreamEvent> {
          void start();
          yield* queue.drain();
        },
        finalResult: () => start(),
      };
    },

    priceFor(model: string): ModelPricing | null {
      if (!config.pricing || config.pricing === 'free')
        return config.pricing === 'free'
          ? {
              inputPerMTok: 0,
              outputPerMTok: 0,
            }
          : null;
      return config.pricing[model] ?? null;
    },
  };
}

registerBuiltinProvider(KIND, createGeminiProvider);
