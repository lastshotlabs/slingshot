/**
 * The neutral surface: what apps consume.
 *
 * Nothing here names a provider. An app written against these types runs on
 * Claude, on GPT, or on a local Llama with a config change and no code change.
 */
import type { z } from 'zod';
import type {
  AiContentPart,
  AiEffort,
  AiImagePart,
  AiMessage,
  AiMessageContent,
  AiStopReason,
  AiTextPart,
  ModelPricing,
  ProviderCapabilities,
} from './provider/types';

export type {
  AiContentPart,
  AiEffort,
  AiImagePart,
  AiMessage,
  AiMessageContent,
  AiStopReason,
  AiTextPart,
  ModelPricing,
  ProviderCapabilities,
};

/** Arbitrary labels recorded on the usage record and used as metric labels. */
export type AiTags = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Prompt caching: the app declares stability, the package places breakpoints.
// ---------------------------------------------------------------------------

/** One addressable chunk of the system prompt. The `id` is what drift warnings name. */
export interface SystemSegment {
  readonly id: string;
  readonly text: string;
}

/**
 * A system prompt split by stability.
 *
 * `stable` MUST be byte-identical across calls — any change invalidates the
 * prompt cache for everything after it. The package hashes each segment and
 * warns, naming the offending segment, when one drifts. Put per-call content
 * (a timestamp, a match id, a roster) in `volatile`, which is always rendered
 * after the cache breakpoint.
 */
export interface CachedSystem {
  readonly stable: readonly SystemSegment[];
  readonly volatile?: readonly SystemSegment[];
}

/** A plain string is treated as fully volatile (never cached). */
export type SystemPrompt = string | CachedSystem;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Ask the moderator to check this call's output before it reaches the caller. */
export interface AiModerationRequest {
  /** Key into `config.moderation.policies`. */
  readonly policy: string;
  /** `'return'` (default) reports the verdict on the result; `'throw'` raises `AiContentBlockedError`. */
  readonly onBlocked?: 'return' | 'throw';
  /** For structured results: which strings to moderate. Defaults to the whole JSON. */
  readonly extract?: (value: unknown) => readonly string[];
}

export interface AiRequestBase {
  readonly system?: SystemPrompt;
  readonly messages: readonly AiMessage[];
  /** Config key. Defaults to `config.defaultProvider`. */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: AiEffort;
  readonly maxTokens?: number;
  readonly thinking?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * RESPONSE cache (distinct from prompt caching): reuse an identical prior
   * result. `false` disables; omit for the config default (off — a party game
   * wants variety, not determinism).
   */
  readonly cache?: { readonly ttlSeconds?: number; readonly key?: string } | false;
  /** Identity for the prompt-cache drift detector. Defaults to a hash of the stable segment ids. */
  readonly promptCacheKey?: string;
  /** Recorded on the usage record; used as metric labels. e.g. `{ matchId, feature: 'deck-gen' }`. */
  readonly tags?: AiTags;
  /**
   * Budget identity passed to a configured request-scoped spend controller.
   * Multi-user apps normally use a stable user or tenant id.
   */
  readonly spendScope?: string;
  /** Omit for the config default (on); `false` to explicitly skip. */
  readonly moderation?: AiModerationRequest | false;
}

/** One provider attempt presented to an app-supplied durable budget controller. */
export interface AiSpendReservationRequest {
  readonly scope: string;
  readonly provider: string;
  readonly model: string;
  readonly operation: 'generate' | 'generateStructured' | 'stream';
  readonly estimatedMaxCostUsd: number | null;
  readonly tags: AiTags | null;
}

/** Actual accounting supplied when a reserved provider attempt finishes. */
export interface AiSpendSettlement {
  readonly usage: AiUsage;
}

/** Reservation returned by a durable, request-scoped spend controller. */
export interface AiSpendReservation {
  settle(settlement: AiSpendSettlement): Promise<void>;
  release(): Promise<void>;
}

/**
 * App-owned durable spend enforcement seam.
 *
 * Slingshot invokes this for every provider attempt, including retries and
 * structured-output repairs. Throwing from `reserve` prevents the paid call.
 */
export interface AiSpendController {
  reserve(request: AiSpendReservationRequest): Promise<AiSpendReservation>;
}

export interface AiStructuredRequest<T> extends AiRequestBase {
  readonly schema: z.ZodType<T>;
  /** Used in provider payloads and repair prompts. Defaults to `'result'`. */
  readonly schemaName?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Token counts plus cost. `costUsd: null` means UNKNOWN; `0` means genuinely free. */
export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** `null` = price unknown. `0` = free (local). Never a fabricated number. */
  readonly costUsd: number | null;
  readonly accounting: 'full' | 'partial' | 'none' | 'estimated';
}

/** Every feature the orchestrator can silently do worse. It never does so silently. */
export type AiDegradableFeature =
  | 'structuredOutput'
  | 'imageInput'
  | 'promptCaching'
  | 'thinking'
  | 'effort'
  | 'streaming'
  | 'costAccounting'
  | 'refusalSignal'
  | 'moderation';

/**
 * A record that you got less than you asked for.
 *
 * This is the package's central honesty mechanism. `AiResult.degradations` is
 * empty exactly when everything requested was honored — so an app (or a test)
 * can assert `result.degradations.length === 0` and mean it.
 */
export interface AiDegradation {
  readonly feature: AiDegradableFeature;
  readonly requested: string;
  readonly applied: string;
  readonly reason: string;
}

export type AiSeverity = 'none' | 'low' | 'medium' | 'high';

/** Per-item verdict when an array was moderated in one batched call. */
export interface AiItemVerdict {
  readonly index: number;
  readonly allowed: boolean;
  readonly categories: readonly string[];
  readonly severity: AiSeverity;
  readonly reason: string;
}

export interface AiVerdict {
  readonly allowed: boolean;
  readonly categories: readonly string[];
  readonly severity: AiSeverity;
  readonly reason: string;
  readonly items?: readonly AiItemVerdict[];
  /** `null` for a non-LLM moderator (a local classifier costs nothing). */
  readonly usage: AiUsage | null;
  readonly strategy: 'independent' | 'self' | 'both';
  /** Set when `strategy === 'both'` and the two passes disagreed. Also emitted as a metric. */
  readonly disagreement?: boolean;
}

export interface AiResult<T> {
  readonly value: T;
  readonly stopReason: AiStopReason;
  readonly usage: AiUsage;
  readonly moderation: AiVerdict | null;
  /** Empty ⇒ everything you asked for was honored. Non-empty ⇒ read it. */
  readonly degradations: readonly AiDegradation[];
  readonly provider: string;
  readonly model: string;
  readonly cached: 'response' | 'none';
  readonly latencyMs: number;
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type AiStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'thinking'; readonly delta: string }
  | { readonly type: 'done'; readonly stopReason: AiStopReason };

export interface AiStream extends AsyncIterable<AiStreamEvent> {
  finalResult(): Promise<AiResult<string>>;
}

// ---------------------------------------------------------------------------
// Background generation
// ---------------------------------------------------------------------------

/**
 * Discriminated on purpose: a caller physically cannot ignore whether the work
 * was queued or ran inline. `{runId?: string}` would let them.
 */
export type AiBackgroundHandle<T> =
  | { readonly mode: 'queued'; readonly runId: string }
  | { readonly mode: 'sync'; readonly result: T };

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface AiProviderInfo {
  readonly name: string;
  readonly kind: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;
  readonly isDefault: boolean;
}

/** Generation. Consumed via `ctx.capabilities.require(AiClientCap)`. */
export interface AiClient {
  generate(req: AiRequestBase): Promise<AiResult<string>>;
  generateStructured<T>(req: AiStructuredRequest<T>): Promise<AiResult<T>>;
  stream(req: AiRequestBase): AiStream;
  /** Queued when `slingshot-orchestration` is installed; synchronous otherwise. */
  generateStructuredInBackground<T>(
    req: AiStructuredRequest<T>,
  ): Promise<AiBackgroundHandle<AiResult<T>>>;
  /** "Does this provider actually support X?" — ask before you rely. */
  capabilitiesOf(provider?: string): ProviderCapabilities;
  providers(): readonly AiProviderInfo[];
  /** `null` when the provider cannot count tokens. */
  countTokens(
    req: Pick<AiRequestBase, 'system' | 'messages' | 'model' | 'provider'>,
  ): Promise<number | null>;
}

/**
 * Safety verdicts. A separate capability because it is independently useful:
 * moderating player-typed content involves no generation at all, and a package
 * that only needs safety should not take a dependency on a surface that can
 * spend money making tokens. It is also the natural swap point for a non-LLM
 * classifier.
 */
export interface AiModerator {
  moderate(req: {
    readonly content: string | readonly string[];
    readonly policy: string;
    readonly tags?: AiTags;
    readonly spendScope?: string;
  }): Promise<AiVerdict>;
  policies(): readonly string[];
}

export interface AiUsageFilter {
  readonly since?: number;
  readonly until?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly tags?: AiTags;
  readonly limit?: number;
}

export interface AiUsageSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Cost of calls whose price is known. */
  readonly costUsd: number;
  /** How many calls had NO known price — so `costUsd` is not mistaken for the total. */
  readonly unpricedCalls: number;
}

export interface SpendStatus {
  readonly period: 'hour' | 'day' | 'month';
  readonly windowStart: number;
  readonly spentUsd: number;
  readonly softLimitUsd: number | null;
  readonly hardLimitUsd: number | null;
  readonly state: 'ok' | 'soft' | 'hard';
}

export interface AiUsageRecordView {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** `null` = the call could not be priced. NOT zero. */
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly tags: AiTags | null;
  readonly createdAt: number;
}

/** Reads over usage/cost/spend. Consumed by admin surfaces, never by generation code. */
export interface AiUsageReader {
  summary(filter?: AiUsageFilter): Promise<AiUsageSummary>;
  spend(): Promise<SpendStatus>;
  records(filter?: AiUsageFilter): Promise<readonly AiUsageRecordView[]>;
}
