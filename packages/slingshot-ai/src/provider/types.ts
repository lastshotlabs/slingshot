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
  /**
   * The provider ALWAYS reasons and cannot be told not to.
   *
   * xAI is the case: `thinking: {type: 'disabled'}` is accepted and silently
   * ignored (measured: 33 reasoning tokens with the flag set), and
   * `reasoning_effort: 'none'` is a hard 400. Reasoning is a MODEL choice there
   * (`grok-4.20-…-non-reasoning` is a separate model), not a per-call flag.
   *
   * This exists so that a caller asking for thinking OFF gets a DEGRADATION
   * rather than a silent 9× output-token bill. `thinking: 'none'` would be a lie
   * (the provider does reason); without this flag the orchestrator has no way to
   * say "it reasons, and you cannot stop it".
   */
  readonly thinkingAlwaysOn?: boolean;
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
  /** Whether the provider accepts inline image parts in conversation messages. */
  readonly imageInput: boolean;
  readonly toolUse: boolean;
  readonly maxOutputTokens: number;
}

/** A single rendered system block. `cache: true` marks a breakpoint AFTER this block. */
export interface RenderedSystemBlock {
  readonly text: string;
  /** Only honored when `capabilities.promptCaching === 'explicit'`. */
  readonly cache: boolean;
}

/** A text fragment inside a multimodal conversation turn. */
export interface AiTextPart {
  readonly type: 'text';
  readonly text: string;
}

/** An inline image. The caller owns MIME validation and payload-size limits. */
export interface AiImagePart {
  readonly type: 'image';
  readonly mediaType: string;
  /** Base64 payload without a data-URL prefix. */
  readonly data: string;
}

/** Provider-neutral content accepted by every Slingshot AI request. */
export type AiContentPart = AiTextPart | AiImagePart;
export type AiMessageContent = string | readonly AiContentPart[];

/** A conversation turn. String content remains the concise text-only form. */
export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: AiMessageContent;
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
  /**
   * Output tokens billed at the OUTPUT rate — and that INCLUDES reasoning tokens.
   *
   * A reasoning model's chain-of-thought is billed as output, and the vendors
   * report it with the SAME field name and OPPOSITE meanings. Both measured:
   *
   *   - **xAI**: `completion_tokens` EXCLUDES reasoning.
   *     `prompt 215 + completion 5 + reasoning 41 = total 261`. Reading
   *     `completion_tokens` alone bills 5 of the 46 output tokens actually
   *     produced — an **~89% undercount**, and the spend guard is blind to it.
   *   - **DeepSeek**: `completion_tokens` INCLUDES reasoning.
   *     `completion 45, of which reasoning 39`. ADDING reasoning here would
   *     DOUBLE-count it.
   *
   * So the adapter must know its vendor's convention (`Preset.mapUsage`) and
   * report the true billable total here. There is deliberately no separate
   * `reasoningTokens` billing field: a fifth number that is already inside a
   * fourth is precisely the trap that produced this bug in the first place.
   * (The raw split is still on `ProviderResult.raw` for observability.)
   */
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /**
   * The vendor's own authoritative cost for this call, when it reports one.
   *
   * When present this BEATS the price table, and that is the point: a table we
   * maintain by hand cannot know about a context tier, an unpublished cache rate,
   * a promo, or a price change shipped this morning. xAI returns
   * `usage.cost_in_usd_ticks` (1 tick = 1e-10 USD — derived exactly against five
   * live calls across two models; see `openaiCompatible.ts`).
   *
   * `undefined` = the vendor said nothing → fall back to the table.
   * This is NOT "the provider computing cost" (still forbidden); it is the
   * provider REPORTING what the vendor charged, which is strictly better
   * information than anything we can derive.
   */
  readonly reportedCostUsd?: number;
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
  /**
   * Prices ABOVE a context-length breakpoint. xAI doubles every rate above a
   * 200K-token prompt ($1.25 → $2.50 in, $2.50 → $5.00 out on grok-4.3).
   *
   * A flat table applied to a 200K+ prompt is not slightly wrong, it is 2× wrong,
   * and wrong in the dangerous direction: the PRE-FLIGHT spend guard would let
   * through a call costing double what it estimated. Modelled rather than
   * ignored, because "we'll never send prompts that big" is exactly the
   * assumption that stops being true.
   */
  readonly contextTier?: {
    /** Applies when total prompt tokens EXCEED this. */
    readonly aboveInputTokens: number;
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cacheReadPerMTok?: number;
    readonly cacheWritePerMTok?: number;
  };
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
