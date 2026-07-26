/** Google Gemini GenerateContent transport (REST, no SDK dependency). */
import type { AiProviderConfig } from '../config';
import { AiConfigError, AiProviderError, AiRateLimitError, AiTimeoutError } from '../errors';
import { createEventQueue } from '../lib/eventQueue';
import { toolResultWireText } from '../lib/toolContent';
import { resolveCapabilities } from './capabilities';
import { type BuildProviderDeps, registerBuiltinProvider } from './registry';
import type {
  AiContentPart,
  AiProvider,
  AiStopReason,
  AiToolChoice,
  ModelPricing,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
  ProviderStream,
  ProviderStreamEvent,
  ProviderToolCall,
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
  toolUse: true,
  maxOutputTokens: 65_536,
});

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
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

/**
 * Gemini emits NO id on a `functionCall` and matches a `functionResponse` by
 * function NAME. The seam needs an id, so one is synthesized from the part's
 * position — deterministic, and stable for as long as the response is.
 *
 * The consequence is real and is Gemini's, not ours: two concurrent calls to the
 * SAME tool in one turn are indistinguishable in the response the model reads
 * back. `AiToolResultPart` carries `name` precisely so this adapter has anything
 * at all to match on.
 */
function toolCallsOf(payload: GeminiResponse): ProviderToolCall[] {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const calls: ProviderToolCall[] = [];
  parts.forEach((part, index) => {
    if (!part.functionCall?.name) return;
    calls.push({
      id: `call_${index}`,
      name: part.functionCall.name,
      argumentsJson: JSON.stringify(part.functionCall.args ?? {}),
    });
  });
  return calls;
}

/**
 * Gemini's `parameters` is its OpenAPI subset, which rejects
 * `additionalProperties` — and `sanitizeJsonSchema` sets
 * `additionalProperties: false` on every object node because the STRICT
 * providers require it. The two requirements are directly opposed, so the
 * vendor-specific half lives here, in the vendor's adapter, rather than
 * weakening the shared sanitizer for everyone.
 */
function stripAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAdditionalProperties);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue;
    out[key] = stripAdditionalProperties(value);
  }
  return out;
}

/** `'required'` is `'ANY'` here, and the vocabulary is upper-case. */
function mapToolMode(choice: AiToolChoice): string {
  if (choice === 'required') return 'ANY';
  return choice.toUpperCase();
}

function toGeminiPart(part: AiContentPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image':
      return { inlineData: { mimeType: part.mediaType, data: part.data } };
    case 'tool_call':
      return { functionCall: { name: part.name, args: parseArgsObject(part.argumentsJson) } };
    case 'tool_result':
      // Matched by NAME — there is no id on this wire. `response` must be an
      // object, so a scalar or string result is wrapped rather than sent bare.
      return {
        functionResponse: {
          name: part.name,
          response: { result: toolResultWireText(part) },
        },
      };
  }
}

function parseArgsObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
          : message.content.map(toGeminiPart),
    })),
    ...(req.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: req.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parameters: stripAdditionalProperties(tool.jsonSchema),
              })),
            },
          ],
          ...(req.toolChoice
            ? { toolConfig: { functionCallingConfig: { mode: mapToolMode(req.toolChoice) } } }
            : {}),
        }
      : {}),
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
  const apiKey = deps.apiKey;

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
          'x-goog-api-key': apiKey,
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
      const toolCalls = toolCallsOf(payload);
      return {
        text: textOf(payload),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        // Gemini returns `finishReason: 'STOP'` alongside `functionCall` parts.
        // The orchestrator's loop keys off the stop reason, so the adapter — the
        // only layer that can see both — normalizes it.
        stopReason:
          toolCalls.length > 0 ? 'tool_use' : mapStopReason(payload.candidates?.[0]?.finishReason),
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
        const toolCalls: ProviderToolCall[] = [];

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
              // Gemini does NOT stream function arguments incrementally — a
              // `functionCall` part arrives whole, in one frame. So the delta
              // event carries the complete arguments and fires exactly once per
              // call, which still satisfies its purpose (naming the call as
              // early as the wire allows).
              for (const call of toolCallsOf(payload)) {
                const id = `call_${toolCalls.length}`;
                toolCalls.push({ ...call, id });
                queue.push({
                  type: 'tool_call_delta',
                  id,
                  name: call.name,
                  argumentsDelta: call.argumentsJson,
                });
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
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          stopReason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(finishReason),
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
