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
import { createEventQueue } from '../lib/eventQueue';
import { resolveCapabilities } from './capabilities';
import { type BuildProviderDeps, registerBuiltinProvider } from './registry';
import type {
  AiEffort,
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
const GROK_KIND = 'grok';
const DEEPSEEK_KIND = 'deepseek';

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
  imageInput: false,
  toolUse: false,
  maxOutputTokens: 4096,
});

/** OpenAI proper: same wire protocol, genuinely more capable. */
const OPENAI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  ...COMPATIBLE_CAPABILITIES,
  structuredOutput: 'native',
  // OpenAI caches long prefixes on its own; there is no breakpoint to place.
  promptCaching: 'automatic',
  // But "automatic" does not mean "unconditional", and this number is NOT the
  // documented one. OpenAI publishes a 1,024-token minimum. Measured on
  // gpt-5.4-mini — identical prefix, second call, `cached_tokens` on call 2:
  //
  //     1,217 -> 0        1,457 -> 1,280
  //     1,337 -> 0        2,417 -> 2,304
  //
  // The real cliff is above 1,337, and cached blocks land in 128-token
  // increments. A prefix under it never caches — no error, no signal, full price
  // forever. hotseat's moderation prompt (~1,213 tokens) sat just under it and
  // cached 0% of every call.
  //
  // An automatic provider takes no breakpoint from us, so there is nothing to
  // withhold; this value's only job is to let `renderSystem` DEGRADE and say so
  // out loud. 1,536 is the next 128-block above the measured failure — chosen to
  // be honest about uncertainty rather than to squeeze the last 100 tokens.
  promptCacheMinTokens: 1536,
  // The GPT-5 family reasons, and — unlike xAI — it can genuinely be told not to:
  // `reasoning_effort: 'none'` is accepted and yields 0 reasoning tokens
  // (measured on gpt-5.4-mini). Accepted values are `none | low | medium | high`;
  // `minimal` is a 400.
  thinking: 'adaptive',
  effort: true,
  usageAccounting: 'full',
  costAccounting: true,
  refusalSignal: true,
  imageInput: true,
  toolUse: true,
  maxOutputTokens: 16_384,
});

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * `gpt-4o-mini` was two generations stale AND — with `max_tokens` — could not
 * have called anything newer. See `maxTokensParam` below.
 */
const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';

/**
 * Per-million-token prices, verified against developers.openai.com/api/docs/pricing
 * on 2026-07-13. Config `providers[x].pricing` overrides this, so a price change
 * never needs a package release — and an unlisted model prices as `null`
 * (unknown), never as a fabricated number.
 *
 * The `gpt-4o` line is deliberately retained: it still works, and it is the one
 * generation that takes the legacy `max_tokens` param.
 */
const OPENAI_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gpt-5.6-sol': { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5 },
  'gpt-5.6-terra': { inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25 },
  'gpt-5.6-luna': { inputPerMTok: 1, outputPerMTok: 6, cacheReadPerMTok: 0.1 },
  'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5 },
  'gpt-5.5-pro': { inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25 },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, cacheReadPerMTok: 0.075 },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25, cacheReadPerMTok: 0.02 },
  'gpt-5.4-pro': { inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
});

// ---------------------------------------------------------------------------
// grok (xAI) — docs.x.ai, verified 2026-07-13
// ---------------------------------------------------------------------------

/**
 * xAI genuinely enforces a JSON Schema ("when using supported schema features,
 * the response is guaranteed to match your schema"), and caches prefixes on its
 * own — automatic, so there is no breakpoint to place and nothing to degrade.
 *
 * `refusalSignal` is declared FALSE. xAI is OpenAI-compatible on the wire but
 * does not document a `message.refusal` field, and under-declaring costs us
 * nothing here (a `content_filter` finish_reason still maps to `'refusal'`),
 * while over-declaring would have the orchestrator trust a signal that may never
 * arrive.
 */
const GROK_CAPABILITIES: ProviderCapabilities = Object.freeze({
  ...COMPATIBLE_CAPABILITIES,
  structuredOutput: 'native',
  promptCaching: 'automatic',
  // It reasons, and you cannot stop it — only steer how hard. Measured:
  // `thinking: {type:'disabled'}` is accepted and IGNORED (33 reasoning tokens
  // anyway); `reasoning_effort: 'none'` is a hard 400. On xAI, "non-reasoning" is
  // a separate MODEL (`grok-4.20-0309-non-reasoning`), not a flag.
  thinking: 'adaptive',
  thinkingAlwaysOn: true,
  effort: true,
  usageAccounting: 'full',
  costAccounting: true,
  refusalSignal: false,
  toolUse: true,
  maxOutputTokens: 32_768,
});

const GROK_BASE_URL = 'https://api.x.ai/v1';

/**
 * `grok-4.3`, not `grok-4.5`. 4.5 is the coding-grade model; 4.3 is the general
 * one, at roughly a third of the output price ($2.50 vs $6.00 per MTok) — and for
 * creative generation it is the sensible default. Override per app if you need 4.5.
 */
const GROK_DEFAULT_MODEL = 'grok-4.3';

/**
 * Input/output verified against docs.x.ai/docs/pricing on 2026-07-13.
 *
 * **The cached rates are not published anywhere** — not on the pricing page, not
 * on the caching page. They are DERIVED, exactly, from the vendor's own
 * `cost_in_usd_ticks`: two identical-prompt calls per model (one cold, one
 * cache-hit) give two equations in two unknowns (the tick unit and the cached
 * rate), and both models solve to clean numbers with zero residual:
 *
 *   grok-4.5 → cached $0.50/MTok  (4× off the $2.00 input rate)
 *   grok-4.3 → cached $0.20/MTok  (6.25× off the $1.25 input rate)
 *
 * $0.20 is exactly the figure xAI's billing console shows for grok-4.3 — an
 * independent confirmation that the derivation is right rather than merely
 * self-consistent.
 *
 * Previously this table OMITTED the cached rate, and `computeUsage()` fell back to
 * the full input price: a **6.25× overcharge** on every cached token, on a provider
 * that caches automatically and aggressively (a cold call still reported 128 cached
 * tokens). "Wrong in the safe direction" is still wrong, and it silently poisons a
 * spend guard.
 *
 * `contextTier` encodes xAI's documented doubling above a 200K-token prompt.
 * In practice `reportedCostUsd` makes it moot for BILLING — but the pre-flight
 * spend estimate has no vendor figure to lean on, and must not under-estimate.
 */
const GROK_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'grok-4.5': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.5,
    contextTier: { aboveInputTokens: 200_000, inputPerMTok: 4, outputPerMTok: 12 },
  },
  'grok-4.3': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextTier: {
      aboveInputTokens: 200_000,
      inputPerMTok: 2.5,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.4,
    },
  },
  'grok-4.20-0309-reasoning': { inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.2 },
  'grok-4.20-0309-non-reasoning': { inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.2 },
  'grok-4.20-multi-agent-0309': { inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.2 },
});

// ---------------------------------------------------------------------------
// deepseek — api-docs.deepseek.com, verified 2026-07-13
// ---------------------------------------------------------------------------

/**
 * DeepSeek supports `response_format: {type: 'json_object'}` ONLY — no
 * `json_schema`, no strict enforcement. So: `json-mode`, declared honestly.
 *
 * That is not a defect, it is the degradation path this package was built for:
 * the orchestrator injects the schema into the prompt AND sets `json_object`,
 * then `safeParse`s the result and repairs it if needed. DeepSeek is therefore
 * the provider that proves the design does something — a `native` provider never
 * exercises the fallback at all.
 *
 * It also happens to satisfy DeepSeek's documented requirement that the word
 * "json" appear in the prompt, for free, because `jsonInstruction()` is injected
 * on the json-mode path.
 *
 * Caching is automatic and on by default for every account.
 */
const DEEPSEEK_CAPABILITIES: ProviderCapabilities = Object.freeze({
  ...COMPATIBLE_CAPABILITIES,
  structuredOutput: 'json-mode',
  promptCaching: 'automatic',
  streaming: true,
  // Unlike xAI, thinking here is a genuine per-call toggle — and it DEFAULTS TO
  // ENABLED at the vendor, so `requestExtras` sends `disabled` explicitly.
  // Measured cost of leaving it on: 9× the output tokens on a trivial prompt,
  // 3.2× on a moderation-shaped one.
  thinking: 'adaptive',
  effort: true,
  usageAccounting: 'full',
  costAccounting: true,
  refusalSignal: false,
  toolUse: true,
  maxOutputTokens: 8192,
});

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * `deepseek-v4-flash`, NOT `deepseek-chat`.
 *
 * `deepseek-chat` and `deepseek-reasoner` are DEPRECATED on 2026-07-24 — eleven
 * days after this was written. Shipping either as the default would have been a
 * time bomb with a known fuse length.
 */
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * Verified against api-docs.deepseek.com/quick_start/pricing on 2026-07-13.
 *
 * The cache-hit rate is 50× cheaper than cache-miss, which is why
 * `mapDeepSeekUsage` matters: read the cache split wrong and every cached token
 * is billed at 50× its real price, on the provider chosen precisely because it
 * is cheap.
 */
const DEEPSEEK_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'deepseek-v4-flash': {
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
    cacheReadPerMTok: 0.0028,
  },
  'deepseek-v4-pro': {
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    cacheReadPerMTok: 0.003625,
  },
});

// ---------------------------------------------------------------------------
// Wire types (only the fields we read)
// ---------------------------------------------------------------------------

interface ChatChoice {
  message?: {
    content?: string | null;
    refusal?: string | null;
    /** DeepSeek thinking mode. Sits ALONGSIDE `content` — never part of it. */
    reasoning_content?: string | null;
  };
  delta?: { content?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenAI + xAI: `cached_tokens` is a SUBSET of `prompt_tokens`. */
  prompt_tokens_details?: { cached_tokens?: number };
  /**
   * Reasoning tokens, billed at the OUTPUT rate by every vendor here — but
   * whether they are ALREADY inside `completion_tokens` differs per vendor.
   * See `mapGrokUsage` / `mapDeepSeekUsage`. Getting this wrong is silent.
   */
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek: already disjoint, and they sum to `prompt_tokens`. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** xAI ONLY: the vendor's authoritative cost. 1 tick = 1e-10 USD. */
  cost_in_usd_ticks?: number;
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

/**
 * The OpenAI family's usage shape, mapped to DISJOINT counts.
 *
 * `prompt_tokens` is the TOTAL input, and `prompt_tokens_details.cached_tokens`
 * is a SUBSET of it — whereas `ProviderUsage.inputTokens` is defined as the
 * portion billed at the FULL rate, because `computeUsage()` bills the four
 * fields additively. Reporting the total here bills every cached token twice:
 * once at the input rate and again at the cache-read rate.
 *
 * (Anthropic reports disjoint counts natively, which is why the additive formula
 * was right there and quietly wrong here.)
 */
function mapUsage(usage: ChatUsage | undefined): ProviderUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    // OpenAI's o-series reports `completion_tokens` INCLUSIVE of
    // `reasoning_tokens` (as does DeepSeek). Adding the reasoning count here
    // would double-bill it. xAI is the odd one out — see `mapGrokUsage`.
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    // No server in this family reports (or bills) cache WRITES separately.
    cacheWriteTokens: 0,
  };
}

/** 1 xAI cost tick = 1e-10 USD. Derived below, not guessed. */
const GROK_USD_PER_TICK = 1e-10;

/**
 * xAI, where `completion_tokens` EXCLUDES reasoning — the opposite of everyone
 * else in this family, with the same field name.
 *
 * Measured against the live API (grok-4.5): `prompt 215, completion 5,
 * reasoning 41, total 261`. Note **215 + 5 + 41 = 261**: the reasoning tokens
 * are additive to the total, so `completion_tokens` alone is only the visible
 * answer. Billing on it charges for 5 of the 46 output tokens actually produced
 * — an **~89% undercount** — and the pre-flight spend guard, which is the thing
 * standing between a repair loop and a surprise bill, never sees the difference.
 *
 * The cost is cross-checked, not assumed. xAI reports `cost_in_usd_ticks`, and
 * solving two identical-prompt calls (one cold, one cache-hit) for the two
 * unknowns gives EXACT answers on both models — which simultaneously proves the
 * tick unit, the cached rate, AND that reasoning bills at the output rate:
 *
 *   grok-4.5  in $2.00  out $6.00  → cached solves to $0.50/MTok, tick = 1e-10
 *   grok-4.3  in $1.25  out $2.50  → cached solves to $0.20/MTok, tick = 1e-10
 *
 * $0.20 is exactly what xAI's console shows for grok-4.3, which is the
 * independent confirmation — the docs publish no cached rate at all. Every one of
 * five live calls reproduces its reported ticks to the tick.
 */
function mapGrokUsage(usage: ChatUsage | undefined): ProviderUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const ticks = usage?.cost_in_usd_ticks;

  return {
    inputTokens: Math.max(0, prompt - cached),
    // The whole billable output: what you can read, PLUS what it thought first.
    outputTokens: completion + reasoning,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    // The vendor's own figure. Beats the table, and is the only thing that knows
    // about the >200K context tier without us modelling it.
    ...(typeof ticks === 'number' ? { reportedCostUsd: ticks * GROK_USD_PER_TICK } : {}),
  };
}

/**
 * DeepSeek reports the split at the top level of `usage`, not under
 * `prompt_tokens_details` — and reports it ALREADY DISJOINT, which is exactly
 * the shape we want.
 *
 * Using the generic mapper here would read `cached_tokens: undefined` → 0, and
 * then bill the whole prompt at the cache-MISS rate. DeepSeek's cache-hit input
 * is $0.0028/MTok against $0.14 cache-miss — a **50× overstatement** on the
 * cached portion, on the provider whose entire selling point is that it is cheap.
 */
function mapDeepSeekUsage(usage: ChatUsage | undefined): ProviderUsage {
  const hit = usage?.prompt_cache_hit_tokens;
  const miss = usage?.prompt_cache_miss_tokens;

  // Fall back to the generic shape if the split is absent (an older deployment,
  // or a proxy that drops the fields) rather than reporting nonsense.
  if (hit === undefined && miss === undefined) return mapUsage(usage);

  return {
    inputTokens: miss ?? 0,
    // `completion_tokens` INCLUDES `reasoning_tokens` here — measured:
    // `completion 45, of which reasoning 39`, and `prompt 18 + completion 45 =
    // total 63`. Adding reasoning would double-bill it, which is the exact
    // mirror-image of the xAI bug. DeepSeek's docs state NEITHER convention, so
    // this line rests on the measurement and on `usageDisjoint.test.ts`, which
    // pins both vendors' real payloads.
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: hit ?? 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Map our neutral effort scale onto a vendor's, per its documented vocabulary.
 *
 * The scales genuinely differ, and neither vendor accepts ours verbatim:
 *   - **DeepSeek** takes `high | max`; low/medium are mapped UP to `high`, and
 *     `xhigh` to `max` (per its thinking-mode docs).
 *   - **xAI** takes `low | high`. It explicitly REJECTS `none` (a hard 400,
 *     measured) — which is a different thing from not supporting effort, and is
 *     why "turn reasoning off" is not expressible here at all.
 */
function grokEffort(effort: AiEffort): string {
  return effort === 'low' || effort === 'medium' ? 'low' : 'high';
}

function deepSeekEffort(effort: AiEffort): string {
  return effort === 'xhigh' || effort === 'max' ? 'max' : 'high';
}

/**
 * OpenAI takes `none | low | medium | high` (`minimal` is a 400, measured). Our
 * `xhigh`/`max` clamp to `high` — the top of what it offers.
 */
function openAiEffort(effort: AiEffort): string {
  if (effort === 'low' || effort === 'medium') return effort;
  return 'high';
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
  /**
   * Override the usage mapper. The one thing the vendors genuinely disagree
   * about: OpenAI and xAI nest `cached_tokens` inside `prompt_tokens_details`
   * (as a subset of the total), DeepSeek reports a disjoint hit/miss split at
   * the top level. Everything else in this family is byte-identical.
   */
  readonly mapUsage?: (usage: ChatUsage | undefined) => ProviderUsage;
  /**
   * Per-request headers. `promptCacheKey` is a ROUTING key for automatic-caching
   * providers: xAI wants `x-grok-conv-id` so the request lands on the server that
   * already holds the prefix.
   */
  readonly cacheKeyHeader?: string;
  /**
   * ...and OpenAI wants the same routing key as a BODY field (`prompt_cache_key`),
   * not a header. The seam modelled only headers, so on `openai` the key had
   * nowhere to go and was silently dropped — the abstraction quietly excluded the
   * provider it was named after.
   *
   * A preset declares whichever one its vendor speaks. Neither is a default.
   */
  readonly cacheKeyBodyParam?: string;
  /**
   * Vendor-specific body fields — today, reasoning control.
   *
   * This is NOT cosmetic. DeepSeek's thinking mode **defaults to ENABLED**, so
   * simply not sending the flag means paying for a chain-of-thought on every
   * call (measured: 9× the output tokens on a trivial prompt, 3.2× on a
   * moderation-shaped one). "Off" therefore has to be sent EXPLICITLY — the
   * absence of the field is not the absence of the behaviour.
   */
  readonly requestExtras?: (req: NormalizedRequest) => Record<string, unknown>;
  /**
   * The name of the output-token-limit parameter. Defaults to `max_tokens`.
   *
   * OpenAI renamed it: every model it currently ships (the `gpt-5.x` family)
   * **hard-400s on `max_tokens`** —
   *
   *   "Unsupported parameter: 'max_tokens' is not supported with this model.
   *    Use 'max_completion_tokens' instead."
   *
   * — so the `openai` preset was, in fact, broken against every current OpenAI
   * model and worked only on the legacy `gpt-4o` line it happened to default to.
   *
   * `max_completion_tokens` is verified to work on BOTH the `gpt-5.x` family and
   * legacy `gpt-4o-mini`, so this is a flat per-preset switch rather than a
   * per-model branch — and it does not rot when the next model lands.
   *
   * The rest of the family (xAI, DeepSeek, Ollama, vLLM…) still speaks
   * `max_tokens`. The vendors disagree with each other, and OpenAI disagrees with
   * its own past self; both are load-bearing.
   */
  readonly maxTokensParam?: string;
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

  const mapUsageFor = preset.mapUsage ?? mapUsage;

  function headers(req: NormalizedRequest): Record<string, string> {
    return {
      'content-type': 'application/json',
      // A local Ollama needs no key; sending an empty Authorization header would
      // make some servers 401.
      ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
      // Route to the server holding this prefix. Without it, an automatic cache
      // is a coin flip: the prefix is cacheable, but the request may not land on
      // the machine that cached it.
      ...(preset.cacheKeyHeader && req.promptCacheKey
        ? { [preset.cacheKeyHeader]: req.promptCacheKey }
        : {}),
      ...(config.headers ?? {}),
    };
  }

  function body(req: NormalizedRequest, stream: boolean): Record<string, unknown> {
    // Every system block collapses into one system message. The `cache` flags
    // are dropped on purpose: this family has no explicit breakpoint concept,
    // and the orchestrator already knows that (capabilities say
    // `promptCaching: 'none' | 'automatic'`), so nothing is being hidden.
    const messages: { role: string; content: unknown }[] = [];
    const systemText = req.system.map(block => block.text).join('\n\n');
    if (systemText) messages.push({ role: 'system', content: systemText });
    for (const message of req.messages) {
      messages.push({
        role: message.role,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(part =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : {
                      type: 'image_url',
                      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
                    },
              ),
      });
    }

    const payload: Record<string, unknown> = {
      model: req.model,
      messages,
      [preset.maxTokensParam ?? 'max_tokens']: req.maxTokens,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      // The cache ROUTING key, for a vendor that takes it in the body rather than
      // as a header (OpenAI: `prompt_cache_key`). Same value, same purpose as
      // xAI's `x-grok-conv-id` — a different place on the wire.
      ...(preset.cacheKeyBodyParam && req.promptCacheKey
        ? { [preset.cacheKeyBodyParam]: req.promptCacheKey }
        : {}),
      ...(preset.requestExtras?.(req) ?? {}),
      // LAST, so an app can override anything above it. The alternative to an
      // escape hatch is an app forking the adapter, which is strictly worse.
      ...(config.extraBody ?? {}),
    };

    // NOTE: no `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` —
    // this package has no such knobs by design (they are a 400 on Opus 4.8). That
    // is load-bearing here too: DeepSeek SILENTLY IGNORES all four while thinking
    // is enabled. Not an error — just no effect. If anyone ever adds a
    // temperature knob, it must emit a degradation on a thinking-enabled call, or
    // the caller is being lied to.

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
        headers: headers(req),
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
        // `reasoning_content` (DeepSeek thinking mode) sits alongside `content`
        // and is deliberately NOT read here. Concatenating it would put the
        // model's chain-of-thought into `text` — which then fails to parse as
        // JSON, and, far worse, would be handed to an app that asked for an
        // answer and got the model's private deliberation about the answer.
        text: choice?.message?.content ?? '',
        stopReason,
        usage: mapUsageFor(payload.usage),
        raw: payload,
      };
    },

    stream(req: NormalizedRequest, signal?: AbortSignal): ProviderStream {
      let final: Promise<ProviderResult> | undefined;
      const queue = createEventQueue<ProviderStreamEvent>();

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

              // Thinking deltas are surfaced as their OWN event type and are
              // never accumulated into `text`. This is what keeps the conformance
              // invariant true for a reasoning model: the concatenation of the
              // TEXT deltas still equals `finalResult().text` exactly, because
              // the reasoning never entered either side of that equation.
              const thinking = choice.delta?.reasoning_content;
              if (typeof thinking === 'string' && thinking.length > 0) {
                queue.push({ type: 'thinking', delta: thinking });
              }

              const delta = choice.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                text += delta;
                queue.push({ type: 'text', delta });
              }
            }
          }
        }

        queue.finish();
        return {
          text,
          stopReason: mapStopReason(lastChoice),
          usage: mapUsageFor(usage),
          raw: { streamed: true, usage, finishReason: lastChoice?.finish_reason ?? null },
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
    // Every current OpenAI model rejects `max_tokens`. See `Preset.maxTokensParam`.
    maxTokensParam: 'max_completion_tokens',
    // OpenAI takes the cache routing key in the BODY, where xAI takes a header.
    cacheKeyBodyParam: 'prompt_cache_key',
    // The generic `mapUsage` is correct here: OpenAI's `completion_tokens`
    // INCLUDES `reasoning_tokens` (measured on gpt-5-mini: completion 40, of
    // which reasoning 40, total = prompt + completion). Same as DeepSeek,
    // opposite of xAI.
    requestExtras: req => {
      // `thinking: false` is expressible here — `reasoning_effort: 'none'` really
      // does yield zero reasoning tokens. It wins over `effort`, because asking
      // for no thinking AND a thinking depth is a contradiction, and the cheaper
      // reading of it is the safe one.
      if (req.thinking === false) return { reasoning_effort: 'none' };
      return req.effort ? { reasoning_effort: openAiEffort(req.effort) } : {};
    },
  });
}

/**
 * xAI's Grok — same wire protocol, native schema enforcement, automatic caching.
 *
 * `promptCacheKey` rides as `x-grok-conv-id`, which xAI's docs call the way to
 * "maximize cache hit rate": the prefix is cacheable either way, but without the
 * header the request may be routed to a server that never saw it.
 */
export function createGrokProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): AiProvider {
  return createProvider(name, config, deps, {
    kind: GROK_KIND,
    baseCapabilities: GROK_CAPABILITIES,
    baseUrl: GROK_BASE_URL,
    defaultModel: GROK_DEFAULT_MODEL,
    pricing: GROK_PRICING,
    requiresApiKey: true,
    cacheKeyHeader: 'x-grok-conv-id',
    mapUsage: mapGrokUsage,
    // Only `reasoning_effort`. There is deliberately no thinking toggle: xAI
    // ignores one silently, so sending it would be theatre. The orchestrator
    // raises a DEGRADATION instead (`thinkingAlwaysOn`), which is the honest
    // answer to "I asked for thinking off and did not get it".
    requestExtras: req => (req.effort ? { reasoning_effort: grokEffort(req.effort) } : {}),
  });
}

/**
 * DeepSeek — the cheap one, and the one that actually exercises the fallback.
 *
 * `json-mode` (not `native`), automatic caching, and a usage mapper of its own
 * because it reports the cache split disjointly at the top level.
 */
export function createDeepSeekProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): AiProvider {
  return createProvider(name, config, deps, {
    kind: DEEPSEEK_KIND,
    baseCapabilities: DEEPSEEK_CAPABILITIES,
    baseUrl: DEEPSEEK_BASE_URL,
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    pricing: DEEPSEEK_PRICING,
    requiresApiKey: true,
    mapUsage: mapDeepSeekUsage,
    requestExtras: req => ({
      // Thinking defaults to ENABLED at the vendor, so "off" must be stated. The
      // orchestrator always resolves `req.thinking` to an explicit boolean on a
      // thinking-capable provider precisely so this is never left to the default.
      ...(req.thinking !== undefined
        ? { thinking: { type: req.thinking ? 'enabled' : 'disabled' } }
        : {}),
      ...(req.effort ? { reasoning_effort: deepSeekEffort(req.effort) } : {}),
    }),
  });
}

registerBuiltinProvider(KIND, createOpenAiCompatibleProvider);
registerBuiltinProvider(OPENAI_KIND, createOpenAiProvider);
registerBuiltinProvider(GROK_KIND, createGrokProvider);
registerBuiltinProvider(DEEPSEEK_KIND, createDeepSeekProvider);
