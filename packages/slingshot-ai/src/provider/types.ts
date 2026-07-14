/**
 * The provider seam.
 *
 * THE RULE THAT MAKES THIS PACKAGE WORK: **providers are dumb transports.**
 * A provider translates one `NormalizedRequest` into one HTTP call and
 * normalizes the response back into a `ProviderResult`. That is all it does.
 *
 * Providers do NOT:
 *   - validate schemas (the orchestrator `safeParse`s every result, from every
 *     provider — see `ProviderResult.structured` below)
 *   - compute cost (they report raw token counts; pricing is orchestrator policy)
 *   - decide retries (they classify errors; the retry layer decides)
 *   - moderate (that is an independent call, possibly to a different provider)
 *
 * Keeping policy out of adapters is why adding a new provider later is
 * mechanical: write the translation, declare your capabilities, pass the
 * conformance suite.
 */
import type { z } from 'zod';

/** Why generation stopped. Normalized across providers. */
export type AiStopReason = 'end' | 'max_tokens' | 'refusal' | 'tool_use' | 'unknown';

/** Effort/thinking-depth hint. Providers that lack the concept degrade and report it. */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * What a provider can actually do.
 *
 * The orchestrator reads this to decide how to satisfy a request and what to
 * record as a degradation when it cannot. Apps read it via
 * `client.capabilitiesOf(provider)` to ask "can I rely on X here?".
 *
 * An adapter MUST declare these honestly. Over-declaring is the only way to get
 * silently wrong behavior out of this package.
 */
export interface ProviderCapabilities {
  /**
   * - `'native'`    — the provider enforces the JSON Schema (Anthropic
   *                   `output_config.format`, OpenAI `json_schema` strict).
   * - `'json-mode'` — the provider guarantees syntactically valid JSON but does
   *                   NOT enforce the shape.
   * - `'none'`      — no JSON guarantee at all. The orchestrator falls back to
   *                   prompt-instructed JSON plus a parse-and-repair loop.
   */
  readonly structuredOutput: 'native' | 'json-mode' | 'none';
  /**
   * - `'explicit'`  — the caller places cache breakpoints (Anthropic `cache_control`).
   * - `'automatic'` — the provider caches prefixes on its own (OpenAI).
   * - `'none'`      — no prompt caching.
   */
  readonly promptCaching: 'explicit' | 'automatic' | 'none';
  /**
   * Minimum cacheable prefix in tokens. REQUIRED when `promptCaching` is
   * `'explicit'`, because a breakpoint below this threshold is accepted by the
   * API and then silently does nothing — the single nastiest failure mode in
   * prompt caching, and the reason the orchestrator refuses to emit one.
   */
  readonly promptCacheMinTokens?: number;
  readonly streaming: boolean;
  readonly thinking: 'adaptive' | 'budget' | 'none';
  readonly effort: boolean;
  /**
   * - `'full'`    — token counts including the cache-read/write breakdown.
   * - `'partial'` — input/output only.
   * - `'none'`    — no usage reported at all.
   */
  readonly usageAccounting: 'full' | 'partial' | 'none';
  /**
   * `false` ⇒ `costUsd` is reported as `null` (unknown) or `0` (genuinely free,
   * e.g. local inference) — NEVER a fabricated number.
   */
  readonly costAccounting: boolean;
  /** The provider emits an explicit refusal signal rather than returning odd content. */
  readonly refusalSignal: boolean;
  readonly toolUse: boolean;
  readonly maxOutputTokens: number;
}

/** A single rendered system block. `cache: true` marks a breakpoint AFTER this block. */
export interface RenderedSystemBlock {
  readonly text: string;
  /** Only honored when `capabilities.promptCaching === 'explicit'`. */
  readonly cache: boolean;
}

/** A conversation turn. */
export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * How the orchestrator decided to get JSON out of this provider, given its
 * declared capabilities. The adapter uses this to pick its request idiom.
 */
export type StructuredMode = 'native' | 'json-mode' | 'prompt';

/** The structured-output ask, pre-resolved by the orchestrator. */
export interface NormalizedStructured {
  readonly name: string;
  /** For adapters with a zod-native helper (e.g. `zodOutputFormat`). */
  readonly zod: z.ZodType<unknown>;
  /** Sanitized JSON Schema — safe to send to a provider that rejects min/max/recursion. */
  readonly jsonSchema: Record<string, unknown>;
  readonly mode: StructuredMode;
}

/** Everything a provider needs to make exactly one call. */
export interface NormalizedRequest {
  readonly model: string;
  /** Ordered. Rendered stable-first; `cache` marks the breakpoint. */
  readonly system: readonly RenderedSystemBlock[];
  readonly messages: readonly AiMessage[];
  readonly maxTokens: number;
  readonly effort?: AiEffort;
  readonly thinking?: boolean;
  readonly structured?: NormalizedStructured;
  readonly timeoutMs: number;
  /**
   * Stable identifier for the cacheable prefix this request shares with others.
   *
   * Providers with `promptCaching: 'automatic'` may take this ON THE WIRE as a
   * routing hint — xAI's `x-grok-conv-id` header and OpenAI's `prompt_cache_key`
   * both exist so that requests sharing a prefix land on the same server, which
   * is what actually turns a cacheable prefix into a cache HIT.
   *
   * The orchestrator has always computed this (for the drift and zero-hit
   * detectors); it now also hands it to the transport, because a provider that
   * can act on it and is never told is a cache that quietly never fires.
   */
  readonly promptCacheKey?: string;
}

/**
 * Raw token counts. Cost is NOT the provider's job.
 *
 * **`inputTokens` MUST EXCLUDE the cached counts.** The four fields are DISJOINT
 * — `pricing.computeUsage()` bills them additively, so an adapter that reports a
 * total which already contains its cache reads charges for them twice.
 *
 * This is not hypothetical: Anthropic reports disjoint counts natively
 * (`input_tokens` excludes `cache_read_input_tokens`), while the OpenAI family
 * reports `prompt_tokens` as a TOTAL with `cached_tokens` as a subset of it.
 * Adapters in that family must subtract. DeepSeek, helpfully, reports the
 * already-disjoint `prompt_cache_miss_tokens`.
 */
export interface ProviderUsage {
  /** Input tokens billed at the FULL rate — i.e. excluding cache reads and writes. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** What a provider hands back. */
export interface ProviderResult {
  readonly text: string;
  /**
   * ADVISORY ONLY. Present when the provider itself produced a parsed object.
   *
   * The orchestrator re-validates this with `schema.safeParse()` for EVERY
   * provider — which is why Anthropic returning `parsed_output: null` and a
   * local model emitting garbage converge on one code path.
   */
  readonly structured?: unknown;
  readonly stopReason: AiStopReason;
  readonly usage: ProviderUsage;
  /** Provider-native response, for debugging. Never inspected by the orchestrator. */
  readonly raw: unknown;
}

/** A streamed delta. */
export type ProviderStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'thinking'; readonly delta: string };

/**
 * A stream of deltas plus the assembled result.
 *
 * Conformance invariant: the concatenation of every `text` delta MUST equal
 * `(await finalResult()).text`. Adapters that emulate streaming over a
 * non-streaming API satisfy this trivially; real streaming adapters get it
 * wrong surprisingly often, which is why the suite asserts it.
 */
export interface ProviderStream extends AsyncIterable<ProviderStreamEvent> {
  finalResult(): Promise<ProviderResult>;
}

/** Per-million-token prices. `null` anywhere means "unknown", never "free". */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

/** The transport contract every adapter implements. */
export interface AiProvider {
  /** Registry key: `'anthropic'`, `'openai-compatible'`, or a custom kind. */
  readonly kind: string;
  /** The config key this instance was built under, e.g. `'local'`. */
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;

  generate(req: NormalizedRequest, signal?: AbortSignal): Promise<ProviderResult>;
  stream(req: NormalizedRequest, signal?: AbortSignal): ProviderStream;

  /** Exact token count when the provider offers one. Used by the pre-flight spend guard. */
  countTokens?(req: NormalizedRequest): Promise<number>;
  /** Price for a model, or `null` when unknown. Config overrides win over this. */
  priceFor?(model: string): ModelPricing | null;
  close?(): Promise<void>;
}

/** What the package hands an adapter factory. The API key is resolved by the PACKAGE. */
export interface ProviderDeps {
  /**
   * Resolved from `ctx.secrets.get(apiKeySecret)` at boot. `null` for providers
   * that need no key (a local Ollama, say).
   *
   * Adapters MUST NOT read `process.env` — the framework resolves secrets at
   * startup and passes them in.
   */
  readonly apiKey: string | null;
  readonly logger: AiLogger;
}

/** The slice of `Logger` this package needs. Structural, so any Logger satisfies it. */
export interface AiLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
