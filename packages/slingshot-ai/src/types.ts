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
  AiToolCallPart,
  AiToolChoice,
  AiToolResultPart,
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
  AiToolCallPart,
  AiToolChoice,
  AiToolResultPart,
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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** What the orchestrator hands a tool when it runs it. Deliberately minimal. */
export interface AiToolContext {
  /** The caller's signal. A long-running tool should honor it. */
  readonly signal?: AbortSignal;
  /** 1-based index of the provider call that produced this tool call. */
  readonly iteration: number;
  /** The provider's id for this call. Correlates with the stream events. */
  readonly toolCallId: string;
}

/**
 * A tool the model may call.
 *
 * `execute` lives here — the framework runs the loop — because spend re-entry,
 * the iteration cap and argument validation are the orchestrator's job, and an
 * app-authored `while` loop around `generate()` cannot do any of the three. The
 * app still observes every call through `AiStream` events and
 * `AiResult.toolCalls`, which is what a tool-trace UI needs and all it needs.
 *
 * The framework NEVER retries `execute`. Retry policy for a side-effecting app
 * function is the app's business; the package's retry layer covers the provider
 * call only.
 *
 * A throwing `execute` becomes an `isError` tool result the model can react to.
 * It does not kill the turn and it does not surface as an exception to the app.
 */
export interface AiTool<A = unknown> {
  readonly name: string;
  /** Shown to the model. The only thing that makes the tool discoverable. */
  readonly description: string;
  /**
   * Validated in the ORCHESTRATOR with `safeParse`, and converted to the JSON
   * Schema the model is shown. Never trusted from the provider, for the same
   * reason `ProviderResult.structured` is advisory.
   */
  readonly schema: z.ZodType<A>;
  /**
   * Declared as a METHOD, not a `readonly` property, on purpose.
   *
   * `readonly execute: (args: A, …) => …` is contravariant in `A` under
   * `strictFunctionTypes`, so `AiTool<{lift: string}>` would not be assignable to
   * `AiTool<unknown>` and a heterogeneous `readonly AiTool[]` — the only useful
   * shape — could not be built without an `any`. Method-shorthand declarations
   * are checked bivariantly, which is exactly the escape hatch TypeScript
   * provides for this case, and it costs nothing here because the orchestrator
   * never assigns an `AiTool` into a narrower one.
   */
  execute(args: A, ctx: AiToolContext): Promise<unknown>;
}

/** What one tool call did, recorded on the result. */
export interface AiToolCallRecord {
  readonly id: string;
  readonly name: string;
  /**
   * The VALIDATED arguments when validation succeeded; otherwise whatever the
   * model's JSON parsed to (or `null`), so the trace is complete either way.
   */
  readonly args: unknown;
  /** `false` for an unknown tool, unparseable arguments, a schema failure, or a throw. */
  readonly ok: boolean;
  readonly durationMs: number;
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
  /**
   * Tools the model may call. Supported by `generate` and `stream`.
   *
   * A provider declaring `toolUse: false` throws rather than silently dropping
   * them — sending the request without the tools would look successful while
   * changing its meaning (the model would answer from memory a question it was
   * supposed to look up). Same rule as inline images.
   *
   * Passing tools to `generateStructured` throws: a structured request tells the
   * model to emit only JSON matching a schema, on exactly the turns it is
   * supposed to be emitting tool calls instead.
   */
  readonly tools?: readonly AiTool[];
  readonly toolChoice?: AiToolChoice;
  /**
   * Maximum PROVIDER CALLS in the tool loop — not tool rounds. With `n` the model
   * gets at most `n - 1` rounds of tool execution. Provider calls are what cost
   * money, which is the unit this package measures in.
   *
   * Defaults to `config.tools.maxIterations`, which is also a hard ceiling:
   * asking for more throws `AiConfigError` before any provider call, because a
   * deployment-level spend ceiling a request can talk its way past is not a
   * ceiling. Hitting the cap is an `AiDegradation`, never a silent truncation.
   */
  readonly maxToolIterations?: number;
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
  | 'moderation'
  | 'toolUse';

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
  /**
   * On a tool loop this is EVERY assistant text turn, concatenated in order —
   * not just the last one. The alternative breaks the streaming invariant
   * outright: deltas the user already watched would be absent from the final
   * text, which is exactly the streaming-UI-vs-saved-transcript disagreement the
   * conformance suite exists to prevent.
   */
  readonly value: T;
  /** From the LAST iteration. */
  readonly stopReason: AiStopReason;
  /**
   * Summed across every iteration of a tool loop. The four token counts stay
   * disjoint WITHIN each iteration (`computeUsage` is unchanged and runs per
   * call), then add ACROSS them. If any iteration could not be priced, `costUsd`
   * is `null` for the whole turn — not the sum of the ones that could, because a
   * total that silently omits a component is a fabricated number.
   */
  readonly usage: AiUsage;
  readonly moderation: AiVerdict | null;
  /** Empty ⇒ everything you asked for was honored. Non-empty ⇒ read it. */
  readonly degradations: readonly AiDegradation[];
  readonly provider: string;
  readonly model: string;
  readonly cached: 'response' | 'none';
  readonly latencyMs: number;
  /** From the LAST iteration. */
  readonly raw: unknown;
  /** Every tool call made this turn, in order. Empty when no tools were used. */
  readonly toolCalls: readonly AiToolCallRecord[];
  /** Provider calls made for this turn. `1` unless a tool loop ran. */
  readonly iterations: number;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * `tool_call_delta` and `tool_call` are two different things and neither is
 * derivable from the other.
 *
 * - `tool_call_delta` is passed through LIVE from the transport, one raw
 *   fragment of the model's argument JSON at a time. It is advisory. Its job is
 *   latency: the function NAME lands in the first frame, hundreds of
 *   milliseconds before the arguments finish, so a trace UI can render "calling
 *   get_lift_trend…" immediately instead of showing nothing. It is emitted for
 *   calls that later fail validation too, because a trace is a record of what
 *   the model did.
 * - `tool_call` is emitted once per call, AFTER `JSON.parse` and
 *   `schema.safeParse`, with the validated arguments. This is the one an app may
 *   act on. Half of `{"lift":"squ` is not arguments.
 *
 * `tool_result` deliberately carries no return payload: a result can be large,
 * the app already has it (it wrote the tool), and a stream is the wrong place to
 * ship a page of rows.
 */
export type AiStreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'thinking'; readonly delta: string }
  | {
      readonly type: 'tool_call_delta';
      readonly id: string;
      readonly name: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly id: string;
      readonly name: string;
      readonly ok: boolean;
      readonly durationMs: number;
    }
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
