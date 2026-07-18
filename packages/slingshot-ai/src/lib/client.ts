/**
 * The orchestrator.
 *
 * Every call, on every provider, walks the same path:
 *
 *   negotiate capabilities → render system (prompt cache) → spend guard
 *     → response cache → provider call (with retry) → refusal check
 *     → **validate** → moderation → usage + metrics → AiResult
 *
 * The load-bearing word is *validate*. `ProviderResult.structured` is ADVISORY:
 * Anthropic can hand back `parsed_output: null` on a refusal, a "native"
 * OpenAI-compatible endpoint can be lying about its schema enforcement, and a
 * local model can hand back a fenced code block with a trailing comma. All three
 * converge on one `schema.safeParse()` in `parseStructured()`. That is the only
 * reason an app can swap providers in config and not in code.
 *
 * The other rule: the package never silently does less than you asked. Anything
 * it cannot honor becomes an `AiDegradation` on the result (and, under
 * `degradation: 'strict'`, an `AiUnsupportedFeatureError` instead).
 */
import type { AiPackageConfig } from '../config';
import {
  AiConfigError,
  AiRefusalError,
  AiStructuredOutputError,
  AiUnsupportedFeatureError,
} from '../errors';
import type {
  AiLogger,
  AiProvider,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
  RenderedSystemBlock,
} from '../provider/types';
import type {
  AiBackgroundHandle,
  AiClient,
  AiDegradation,
  AiMessage,
  AiModerator,
  AiProviderInfo,
  AiRequestBase,
  AiResult,
  AiSpendReservation,
  AiStream,
  AiStreamEvent,
  AiStructuredRequest,
  AiUsage,
  AiVerdict,
} from '../types';
import { messageContentUnits } from './messageContent';
import { createModerator } from './moderation';
import { computeUsage, estimateMaxCost, resolvePricing } from './pricing';
import { createResponseCache, responseCacheKey } from './responseCache';
import { withRetry } from './retry';
import type { AiCacheAdapter, AiEventBus, AiUsageStore } from './seams';
import { createSpendGuard } from './spend';
import {
  chooseStructuredMode,
  jsonInstruction,
  parseStructured,
  repairInstruction,
  toJsonSchema,
} from './structured';
import { PromptCacheMonitor, type RenderedSystem, renderSystem } from './systemPrompt';
import { type UsageRecorder, createUsageRecorder } from './usage';

/** Structural — matches the framework's MetricsEmitter without importing it. */
export interface AiMetrics {
  counter(name: string, value?: number, labels?: Record<string, string>): void;
  timing(name: string, ms: number, labels?: Record<string, string>): void;
}

export interface AiRuntime {
  readonly client: AiClient;
  readonly moderator: AiModerator;
  readonly usage: UsageRecorder;
}

/**
 * How a background generation actually gets queued.
 *
 * Injected rather than imported, so the main entry point never pulls in
 * `slingshot-orchestration`. When it is absent, `generateStructuredInBackground`
 * runs INLINE and says so via the discriminated handle — a caller physically
 * cannot mistake a synchronous run for a durable queued one.
 */
export interface AiBackgroundRunner {
  /** Enqueue and return the run id. */
  enqueue(req: {
    schemaName: string;
    request: Omit<AiStructuredRequest<unknown>, 'schema' | 'signal'>;
  }): Promise<string>;
  /** Whether this schema is registered with the background task. */
  supports(schemaName: string): boolean;
}

export interface CreateAiClientOptions {
  readonly config: AiPackageConfig;
  readonly providers: ReadonlyMap<string, AiProvider>;
  readonly logger: AiLogger;
  readonly metrics?: AiMetrics;
  /** Framework event bus. Used for `ai:spend.soft_limit`. */
  readonly bus?: AiEventBus;
  /** Persistence for the usage ledger. Absent → in-memory only. */
  readonly store?: AiUsageStore | null;
  /** Backing store for the response cache. Absent → in-process Map. */
  readonly cache?: AiCacheAdapter | null;
  /** Durable background generation. Absent → inline, and honestly reported. */
  readonly background?: AiBackgroundRunner | null;
}

interface Resolved {
  readonly name: string;
  readonly provider: AiProvider;
  readonly capabilities: ProviderCapabilities;
  readonly model: string;
}

export function createAiClient(options: CreateAiClientOptions): AiRuntime {
  const { config, providers, logger, metrics } = options;

  const spend = createSpendGuard(config, logger, options.bus);
  const usage = createUsageRecorder(config, spend, options.store, logger);
  // `generateStructured` is a hoisted function declaration below, so the judge
  // runs through the SAME orchestrator path as any other call — spend guard,
  // retry layer, single validation point. A judge with its own private path to
  // the provider would be the one call here that could run away with the budget.
  const moderator = createModerator({
    config,
    logger,
    metrics,
    generateStructured: <T>(req: AiStructuredRequest<T>) => generateStructured(req),
  });
  const responseCache = createResponseCache(config, options.cache, logger);
  const promptMonitor = new PromptCacheMonitor(
    logger,
    config.promptCache.devWarnings,
    config.promptCache.zeroHitWarnAfter,
    (cacheKey, segmentId) =>
      metrics?.counter('ai.prompt_cache.prefix_changed', 1, { cacheKey, segmentId }),
  );

  const strict = config.degradation === 'strict';

  /** Record a degradation — or, under `strict`, refuse to degrade at all. */
  function degrade(into: AiDegradation[], degradation: AiDegradation, providerName: string): void {
    if (strict) {
      throw new AiUnsupportedFeatureError(
        `Provider '${providerName}' cannot honor '${degradation.feature}' ` +
          `(requested: ${degradation.requested}, available: ${degradation.applied}). ` +
          `${degradation.reason}. Configured degradation mode is 'strict', so this throws ` +
          `rather than silently doing less.`,
        { feature: degradation.feature, provider: providerName },
      );
    }
    into.push(degradation);
    if (config.degradation === 'warn') {
      logger.warn(
        `ai: degraded '${degradation.feature}' on provider '${providerName}': ${degradation.reason}`,
        { ...degradation, provider: providerName },
      );
    }
    metrics?.counter('ai.degradation', 1, {
      feature: degradation.feature,
      provider: providerName,
    });
  }

  function resolve(req: { provider?: string; model?: string }): Resolved {
    const name = req.provider ?? config.defaultProvider;
    const provider = providers.get(name);
    if (!provider) {
      throw new AiConfigError(
        `Unknown provider '${name}'. Configured providers: ${[...providers.keys()].join(', ')}.`,
      );
    }
    const providerConfig = config.providers[name];
    const model =
      req.model ?? providerConfig?.defaultModel ?? config.defaults.model ?? provider.defaultModel;
    return { name, provider, capabilities: provider.capabilities, model };
  }

  function priceFor(resolved: Resolved) {
    return resolvePricing({
      providerKind: resolved.provider.kind,
      model: resolved.model,
      providerConfig: config.providers[resolved.name],
      adapterPrice: resolved.provider.priceFor?.(resolved.model) ?? null,
    });
  }

  /**
   * Everything common to `generate` and `generateStructured`: capability
   * negotiation, system rendering, and the base request.
   */
  function prepare(
    req: AiRequestBase,
    resolved: Resolved,
    extraSystem?: string,
  ): {
    request: NormalizedRequest;
    degradations: AiDegradation[];
    rendered: RenderedSystem;
  } {
    const degradations: AiDegradation[] = [];
    const { capabilities: caps, name } = resolved;

    const hasImages = req.messages.some(
      message =>
        Array.isArray(message.content) && message.content.some(part => part.type === 'image'),
    );
    if (hasImages && !caps.imageInput) {
      throw new AiUnsupportedFeatureError(
        `Provider '${name}' does not accept image input. Select an image-capable provider or ` +
          `inspect client.capabilitiesOf(provider).imageInput before sending the request.`,
        { feature: 'imageInput', provider: name },
      );
    }

    const rendered = renderSystem({
      system: req.system,
      capabilities: caps,
      promptCacheEnabled: config.promptCache.enabled,
      promptCacheKey: req.promptCacheKey,
      monitor: promptMonitor,
    });
    for (const degradation of rendered.degradations) degrade(degradations, degradation, name);

    const blocks: RenderedSystemBlock[] = [...rendered.blocks];
    if (extraSystem) {
      // Always AFTER the cache breakpoint: schema instructions are per-call.
      blocks.push({ text: extraSystem, cache: false });
    }

    const wantsThinking = req.thinking ?? config.defaults.thinking ?? false;
    if (wantsThinking && caps.thinking === 'none') {
      degrade(
        degradations,
        {
          feature: 'thinking',
          requested: 'on',
          applied: 'off',
          reason: 'the provider does not support extended thinking',
        },
        name,
      );
    }
    // The reverse, and it is the one that costs money: a provider that ALWAYS
    // reasons and cannot be told not to (xAI — `thinking: {type:'disabled'}` is
    // accepted and ignored, `reasoning_effort: 'none'` is a 400). Asking for it
    // off and silently getting it on is a 9× output-token bill that nothing in
    // the result would have mentioned.
    if (!wantsThinking && caps.thinkingAlwaysOn) {
      degrade(
        degradations,
        {
          feature: 'thinking',
          requested: 'off',
          applied: 'on',
          reason:
            'the provider always reasons and cannot disable it; reasoning tokens are billed at the output rate',
        },
        name,
      );
    }

    const wantsEffort = req.effort ?? config.defaults.effort;
    if (wantsEffort && !caps.effort) {
      degrade(
        degradations,
        {
          feature: 'effort',
          requested: wantsEffort,
          applied: 'none',
          reason: 'the provider has no effort control',
        },
        name,
      );
    }

    if (!caps.costAccounting) {
      degradations.push({
        feature: 'costAccounting',
        requested: 'usd',
        applied: 'tokens-only',
        reason: 'the provider does not report cost; usage.costUsd will be null',
      });
    }

    const requestedMax = req.maxTokens ?? config.defaults.maxTokens;
    const maxTokens = Math.min(requestedMax, caps.maxOutputTokens);

    const request: NormalizedRequest = {
      model: resolved.model,
      system: blocks,
      messages: req.messages,
      maxTokens,
      effort: wantsEffort && caps.effort ? wantsEffort : undefined,
      // EXPLICIT true/false on any provider that has the concept — never
      // `undefined` for "off". DeepSeek's thinking mode DEFAULTS TO ENABLED, so
      // omitting the flag does not mean off, it means "on, and you pay for it".
      // `undefined` is reserved for "this provider has no such concept".
      thinking: caps.thinking !== 'none' ? wantsThinking : undefined,
      timeoutMs: req.timeoutMs ?? config.providers[name]?.timeoutMs ?? config.defaults.timeoutMs,
      // The RENDERED key, not `req.promptCacheKey` — which is optional, and which
      // no app in this repo actually passes. `renderSystem` derives one from the
      // stable segment ids, so every call sharing a prefix shares a key for free.
      //
      // Forwarding the raw request field meant the header was omitted on every
      // real call, and an automatic-caching provider silently re-read the whole
      // prefix each time. Measured on xAI with hotseat's 4,955-token prefix:
      // 128 cached tokens (2.6%) without the header, 4,928 (99.5%) with it. No
      // error, no degradation — just ~10× the input bill, which is precisely the
      // failure `cacheHitRate` is monitored to catch. It caught it.
      //
      // This is a ROUTING hint, not a cache identity: the vendor still matches the
      // real prefix bytes, so a stale or colliding key costs a cold read, never a
      // wrong answer.
      promptCacheKey: rendered.promptCacheRouteKey,
    };

    return { request, degradations, rendered };
  }

  function estimateRequest(resolved: Resolved, request: NormalizedRequest): number | null {
    const inputUnits =
      request.system.reduce((sum, block) => sum + block.text.length, 0) +
      request.messages.reduce((sum, message) => sum + messageContentUnits(message.content), 0);
    return estimateMaxCost({
      inputTokens: Math.ceil(inputUnits / 4),
      maxTokens: request.maxTokens,
      pricing: priceFor(resolved),
    });
  }

  async function reserveScoped(
    source: AiRequestBase,
    resolved: Resolved,
    operation: 'generate' | 'generateStructured' | 'stream',
    estimate: number | null,
  ): Promise<AiSpendReservation | null> {
    if (!config.spend.controller) return null;
    if (!source.spendScope) {
      if (config.spend.requireScope) {
        throw new AiConfigError(
          'slingshot-ai spend.requireScope is enabled, but this request omitted spendScope.',
        );
      }
      return null;
    }
    return config.spend.controller.reserve({
      scope: source.spendScope,
      provider: resolved.name,
      model: resolved.model,
      operation,
      estimatedMaxCostUsd: estimate,
      tags: source.tags ?? null,
    });
  }

  /** Call the provider, re-checking spend before every attempt (retries included). */
  async function callProvider(
    resolved: Resolved,
    request: NormalizedRequest,
    signal: AbortSignal | undefined,
    source: AiRequestBase,
    operation: 'generate' | 'generateStructured' | 'stream',
  ): Promise<ProviderResult> {
    // The messages count too — and they GROW on every repair turn, since each
    // one appends the model's bad answer plus the validation errors. Estimating
    // from the system prompt alone would under-count exactly the loop we most
    // need to catch.
    const estimate = estimateRequest(resolved, request);

    let reservation: AiSpendReservation | null = null;
    return withRetry(
      async () => {
        let result: ProviderResult | undefined;
        try {
          result = await resolved.provider.generate(request, signal);
          if (reservation) {
            await reservation.settle({
              usage: computeUsage({
                usage: result.usage,
                pricing: priceFor(resolved),
                capabilities: resolved.capabilities,
              }),
            });
          }
          return result;
        } catch (error) {
          if (!result) await reservation?.release();
          throw error;
        } finally {
          reservation = null;
        }
      },
      {
        maxAttempts: (config.providers[resolved.name]?.maxRetries ?? 2) + 1,
        logger,
        // THE invariant: every attempt re-enters the spend guard. A retry storm
        // and a repair loop both spend real money, and neither is covered by a
        // single check at the top of the call.
        onAttempt: async () => {
          spend.check(estimate);
          reservation = await reserveScoped(source, resolved, operation, estimate);
        },
      },
    );
  }

  function finishUsage(
    resolved: Resolved,
    result: ProviderResult,
    startedAt: number,
    operation: string,
    tags: Record<string, string> | undefined,
    breakpointEmitted: boolean,
    promptCacheKey: string,
  ): AiUsage {
    const pricing = priceFor(resolved);
    const computed = computeUsage({
      usage: result.usage,
      pricing,
      capabilities: resolved.capabilities,
    });
    const latencyMs = Date.now() - startedAt;

    spend.record(computed.costUsd);
    usage.record({
      provider: resolved.name,
      model: resolved.model,
      operation,
      usage: computed,
      latencyMs,
      tags,
    });
    promptMonitor.recordCacheRead(promptCacheKey, result.usage.cacheReadTokens, breakpointEmitted);

    const labels = { provider: resolved.name, model: resolved.model, operation };
    metrics?.counter('ai.calls', 1, labels);
    metrics?.counter('ai.tokens.input', computed.inputTokens, labels);
    metrics?.counter('ai.tokens.output', computed.outputTokens, labels);
    metrics?.timing('ai.latency', latencyMs, labels);
    if (computed.costUsd !== null) {
      metrics?.counter('ai.cost_usd', computed.costUsd, labels);
    } else {
      // The blind spot, made visible. If this counter is climbing, `ai.cost_usd`
      // is not the whole bill — and a dashboard that showed only the latter
      // would be quietly wrong.
      metrics?.counter('ai.cost.unpriced', 1, labels);
    }
    return computed;
  }

  function checkRefusal(
    result: ProviderResult,
    resolved: Resolved,
    degradations: AiDegradation[],
  ): void {
    if (!resolved.capabilities.refusalSignal) {
      degradations.push({
        feature: 'refusalSignal',
        requested: 'explicit',
        applied: 'none',
        reason:
          'the provider does not signal refusals; a refusal is indistinguishable from a short answer',
      });
      return;
    }
    if (result.stopReason === 'refusal') {
      // A refusal is HTTP 200 with an empty body on Anthropic. Treating it as a
      // successful empty generation is how you ship a blank card to a table of
      // guests.
      throw new AiRefusalError(
        `The model refused to generate this content (provider: ${resolved.name}).`,
        { partialText: result.text },
      );
    }
  }

  async function runModeration(
    req: AiRequestBase,
    value: unknown,
    text: string,
  ): Promise<AiVerdict | null> {
    const request = req.moderation;
    if (!request || !config.moderation.enabled) return null;

    const extracted = request.extract ? request.extract(value) : [text];
    const verdict = await moderator.moderate({
      content: extracted,
      policy: request.policy,
      tags: req.tags,
      spendScope: req.spendScope,
    });

    metrics?.counter('ai.moderation', 1, {
      policy: request.policy,
      allowed: String(verdict.allowed),
    });

    if (!verdict.allowed && request.onBlocked === 'throw') {
      const { AiContentBlockedError } = await import('../errors');
      throw new AiContentBlockedError(
        `Generated content was blocked by moderation policy '${request.policy}': ${verdict.reason}`,
        {
          categories: verdict.categories,
          severity: verdict.severity,
          reason: verdict.reason,
        },
      );
    }
    return verdict;
  }

  // -------------------------------------------------------------------------

  async function generate(req: AiRequestBase): Promise<AiResult<string>> {
    const startedAt = Date.now();
    const resolved = resolve(req);
    const { request, degradations, rendered } = prepare(req, resolved);

    // `cache: false` opts out explicitly; an object opts IN even when the
    // response cache is globally off; omitting it follows the config default.
    const cacheOptions = req.cache === false ? undefined : req.cache;
    const cacheEnabled =
      req.cache !== false && (responseCache.enabled || cacheOptions !== undefined);
    const cacheKey =
      cacheOptions?.key ??
      responseCacheKey({
        provider: resolved.name,
        model: resolved.model,
        system: request.system,
        messages: request.messages,
        maxTokens: request.maxTokens,
        spendScope: req.spendScope,
      });

    if (cacheEnabled) {
      const hit = await responseCache.get<AiResult<string>>(cacheKey);
      if (hit) {
        metrics?.counter('ai.response_cache.hit', 1, { provider: resolved.name });
        return { ...hit, cached: 'response' };
      }
    }

    const run = async (): Promise<AiResult<string>> => {
      const result = await callProvider(resolved, request, req.signal, req, 'generate');
      checkRefusal(result, resolved, degradations);

      const computed = finishUsage(
        resolved,
        result,
        startedAt,
        'generate',
        req.tags,
        rendered.breakpointEmitted,
        rendered.promptCacheKey,
      );
      const moderation = await runModeration(req, result.text, result.text);

      return {
        value: result.text,
        stopReason: result.stopReason,
        usage: computed,
        moderation,
        degradations,
        provider: resolved.name,
        model: resolved.model,
        cached: 'none',
        latencyMs: Date.now() - startedAt,
        raw: result.raw,
      };
    };

    // Coalescing runs ALWAYS, not only when the response cache is on — the two
    // are independent by design. The response cache is off by default (a party
    // game wants variety); coalescing is on by default (five guests tapping the
    // same button at the same instant is one intent, and should be one call).
    // Gating coalescing behind the cache would have quietly disabled it in the
    // default configuration, which is exactly the configuration everyone runs.
    const output = await responseCache.inFlight(cacheKey, run);
    if (cacheEnabled) {
      await responseCache.set(
        cacheKey,
        output,
        cacheOptions?.ttlSeconds ?? config.responseCache.ttlSeconds,
      );
    }
    return output;
  }

  // -------------------------------------------------------------------------

  async function generateStructured<T>(req: AiStructuredRequest<T>): Promise<AiResult<T>> {
    const startedAt = Date.now();
    const resolved = resolve(req);
    const { capabilities: caps } = resolved;
    const schemaName = req.schemaName ?? 'result';

    const jsonSchema = toJsonSchema(req.schema, { logger, strict, name: schemaName });
    const mode = chooseStructuredMode(caps);

    // Build degradations BEFORE `prepare`, so `strict` throws on the structured
    // shortfall rather than on something incidental.
    const structuredDegradations: AiDegradation[] = [];
    if (mode !== 'native') {
      const degradation: AiDegradation = {
        feature: 'structuredOutput',
        requested: 'native',
        applied: mode,
        reason:
          mode === 'json-mode'
            ? 'the provider guarantees valid JSON but does not enforce the schema; the result is validated locally and repaired if needed'
            : 'the provider has no structured-output support; the schema is injected into the prompt, and the result is validated locally and repaired if needed',
      };
      degrade(structuredDegradations, degradation, resolved.name);
    }

    const instruction = mode === 'native' ? undefined : jsonInstruction(schemaName, jsonSchema);
    const { request, degradations, rendered } = prepare(req, resolved, instruction);
    degradations.push(...structuredDegradations);

    const baseRequest: NormalizedRequest = {
      ...request,
      structured:
        mode === 'native' || mode === 'json-mode'
          ? { name: schemaName, zod: req.schema as never, jsonSchema, mode }
          : undefined,
    };

    const maxAttempts = 1 + config.structuredFallback.maxRepairAttempts;
    let messages: AiMessage[] = [...req.messages];
    let lastError: unknown;
    let lastRaw = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptRequest: NormalizedRequest = { ...baseRequest, messages };
      // Each repair attempt is a fresh provider call — and `callProvider`
      // re-enters the spend guard on every one of them, including its retries.
      const result = await callProvider(
        resolved,
        attemptRequest,
        req.signal,
        req,
        'generateStructured',
      );
      checkRefusal(result, resolved, degradations);

      const computed = finishUsage(
        resolved,
        result,
        startedAt,
        'generateStructured',
        req.tags,
        rendered.breakpointEmitted,
        rendered.promptCacheKey,
      );

      // THE single validation point. Every provider, every mode, lands here —
      // and `result.structured` is only ever a hint.
      const parsed = parseStructured<T>({
        schema: req.schema,
        advisory: result.structured,
        text: result.text,
      });

      if (parsed.ok) {
        if (attempt > 1) {
          metrics?.counter('ai.structured.repaired', 1, {
            provider: resolved.name,
            attempts: String(attempt),
          });
        }
        const moderation = await runModeration(req, parsed.value, result.text);
        return {
          value: parsed.value as T,
          stopReason: result.stopReason,
          usage: computed,
          moderation,
          degradations,
          provider: resolved.name,
          model: resolved.model,
          cached: 'none',
          latencyMs: Date.now() - startedAt,
          raw: result.raw,
        };
      }

      lastError = parsed.error;
      lastRaw = parsed.rawText;
      metrics?.counter('ai.structured.invalid', 1, {
        provider: resolved.name,
        attempt: String(attempt),
      });

      if (attempt === maxAttempts) break;

      // The repair turn: show the model its own output and the validation
      // errors. This converges far more often than any regex, and — crucially —
      // it is BOUNDED. An unbounded repair loop against a model that simply
      // cannot produce the shape is an infinite bill.
      logger.debug(
        `ai: structured output failed validation, repairing (attempt ${attempt}/${maxAttempts})`,
        { provider: resolved.name, schema: schemaName },
      );
      messages = [
        ...messages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: repairInstruction(parsed.rawText, parsed.error) },
      ];
    }

    metrics?.counter('ai.structured.failed', 1, { provider: resolved.name });
    throw new AiStructuredOutputError(
      `The model did not produce output matching schema '${schemaName}' after ${maxAttempts} ` +
        `attempt(s) on provider '${resolved.name}' (mode: ${mode}). The raw text and the ` +
        `validation error are attached.`,
      { rawText: lastRaw, zodError: lastError, attempts: maxAttempts },
    );
  }

  // -------------------------------------------------------------------------

  function stream(req: AiRequestBase): AiStream {
    const startedAt = Date.now();
    const resolved = resolve(req);
    const { request, degradations, rendered } = prepare(req, resolved);

    // Streaming and moderation are fundamentally at odds: the deltas reach the
    // user's screen BEFORE there is a complete text to judge. Moderation here
    // can only ever be post-hoc — it can tell you the thing you already showed
    // someone was against policy. Under `strict` that is not an acceptable
    // half-measure, so we refuse rather than imply a protection we don't have.
    if (req.moderation && config.moderation.enabled) {
      degrade(
        degradations,
        {
          feature: 'moderation',
          requested: 'pre-delivery',
          applied: 'post-hoc',
          reason:
            'a streamed response is shown to the user before it is complete, so moderation runs ' +
            'only on finalResult() — after the text has already been read. You cannot un-show it',
        },
        resolved.name,
      );
    }

    let finalPromise: Promise<AiResult<string>> | undefined;

    const toResult = async (result: ProviderResult): Promise<AiResult<string>> => {
      checkRefusal(result, resolved, degradations);
      const computed = finishUsage(
        resolved,
        result,
        startedAt,
        'stream',
        req.tags,
        rendered.breakpointEmitted,
        rendered.promptCacheKey,
      );
      const moderation = await runModeration(req, result.text, result.text);
      return {
        value: result.text,
        stopReason: result.stopReason,
        usage: computed,
        moderation,
        degradations,
        provider: resolved.name,
        model: resolved.model,
        cached: 'none',
        latencyMs: Date.now() - startedAt,
        raw: result.raw,
      };
    };

    // Non-streaming provider: we still honor the AsyncIterable contract by
    // emitting the whole answer as a single delta. The caller gets a correct
    // stream that simply doesn't arrive incrementally — and a degradation
    // saying exactly that, rather than a silent lie about interactivity.
    if (!resolved.capabilities.streaming) {
      degrade(
        degradations,
        {
          feature: 'streaming',
          requested: 'incremental',
          applied: 'single-chunk',
          reason: 'the provider does not stream; the full response arrives as one delta',
        },
        resolved.name,
      );

      const once = async (): Promise<AiResult<string>> => {
        const result = await callProvider(resolved, request, req.signal, req, 'stream');
        return toResult(result);
      };

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AiStreamEvent> {
          finalPromise ??= once();
          const final = await finalPromise;
          yield { type: 'text', delta: final.value };
          yield { type: 'done', stopReason: final.stopReason };
        },
        finalResult(): Promise<AiResult<string>> {
          finalPromise ??= once();
          return finalPromise;
        },
      };
    }

    const estimate = estimateRequest(resolved, request);
    let started:
      | Promise<{
          providerStream: ReturnType<AiProvider['stream']>;
          reservation: AiSpendReservation | null;
        }>
      | undefined;

    const startStream = () => {
      started ??= (async () => {
        spend.check(estimate);
        const reservation = await reserveScoped(req, resolved, 'stream', estimate);
        try {
          return {
            providerStream: resolved.provider.stream(request, req.signal),
            reservation,
          };
        } catch (error) {
          await reservation?.release();
          throw error;
        }
      })();
      return started;
    };

    const finishStream = async (): Promise<AiResult<string>> => {
      const active = await startStream();
      let result: ProviderResult | undefined;
      try {
        result = await active.providerStream.finalResult();
        if (active.reservation) {
          await active.reservation.settle({
            usage: computeUsage({
              usage: result.usage,
              pricing: priceFor(resolved),
              capabilities: resolved.capabilities,
            }),
          });
        }
        return toResult(result);
      } catch (error) {
        if (!result) await active.reservation?.release();
        throw error;
      }
    };

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AiStreamEvent> {
        const active = await startStream();
        try {
          for await (const event of active.providerStream) {
            yield event;
          }
        } catch (error) {
          await active.reservation?.release();
          throw error;
        }
        finalPromise ??= finishStream();
        const final = await finalPromise;
        yield { type: 'done', stopReason: final.stopReason };
      },
      finalResult(): Promise<AiResult<string>> {
        finalPromise ??= finishStream();
        return finalPromise;
      },
    };
  }

  // -------------------------------------------------------------------------

  async function generateStructuredInBackground<T>(
    req: AiStructuredRequest<T>,
  ): Promise<AiBackgroundHandle<AiResult<T>>> {
    const runner = options.background;
    const schemaName = req.schemaName ?? 'result';

    // Queue it when there is a queue AND the schema is registered with the
    // background task. Both halves matter: a zod schema cannot be serialized
    // onto a queue, so the job carries the schema NAME and the worker looks the
    // real schema up in the registry the app supplied at task-creation time. A
    // name the worker doesn't know would be a job that can only ever fail.
    if (runner && runner.supports(schemaName)) {
      const { schema: _schema, signal: _signal, ...serializable } = req;
      void _schema;
      void _signal;

      const runId = await runner.enqueue({ schemaName, request: serializable });
      metrics?.counter('ai.background.queued', 1, { schema: schemaName });
      return { mode: 'queued', runId };
    }

    if (runner) {
      logger.warn(
        `ai: generateStructuredInBackground('${schemaName}') ran INLINE — the schema is not ` +
          `registered with the background task. Add it to createAiGenerationTask({ schemas }) ` +
          `to make it durable.`,
        { schema: schemaName },
      );
    }

    // No queue: run inline, and SAY SO via the discriminated handle. A caller
    // physically cannot mistake a synchronous run for a durable queued one,
    // which is the entire reason the handle is a union rather than `{runId?}`.
    metrics?.counter('ai.background.inline', 1, { schema: schemaName });
    const result = await generateStructured(req);
    return { mode: 'sync', result };
  }

  const client: AiClient = {
    generate,
    generateStructured,
    stream,
    generateStructuredInBackground,

    capabilitiesOf(provider?: string): ProviderCapabilities {
      return resolve({ provider }).capabilities;
    },

    providers(): readonly AiProviderInfo[] {
      return [...providers.entries()].map(([name, provider]) => ({
        name,
        kind: provider.kind,
        defaultModel: provider.defaultModel,
        capabilities: provider.capabilities,
        isDefault: name === config.defaultProvider,
      }));
    },

    async countTokens(req): Promise<number | null> {
      const resolved = resolve(req);
      if (!resolved.provider.countTokens) return null;
      const { request } = prepare({ ...req, messages: req.messages }, resolved);
      return resolved.provider.countTokens(request);
    },
  };

  return { client, moderator, usage };
}
