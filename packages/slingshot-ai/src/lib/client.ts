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
  AiStream,
  AiStreamEvent,
  AiStructuredRequest,
  AiUsage,
  AiVerdict,
} from '../types';
import { createModerator } from './moderation';
import { computeUsage, estimateMaxCost, resolvePricing } from './pricing';
import { createResponseCache, responseCacheKey } from './responseCache';
import { withRetry } from './retry';
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

export interface CreateAiClientOptions {
  readonly config: AiPackageConfig;
  readonly providers: ReadonlyMap<string, AiProvider>;
  readonly logger: AiLogger;
  readonly metrics?: AiMetrics;
}

interface Resolved {
  readonly name: string;
  readonly provider: AiProvider;
  readonly capabilities: ProviderCapabilities;
  readonly model: string;
}

export function createAiClient(options: CreateAiClientOptions): AiRuntime {
  const { config, providers, logger, metrics } = options;

  const spend = createSpendGuard(config, logger);
  const usage = createUsageRecorder(config, spend);
  const moderator = createModerator(config);
  const responseCache = createResponseCache(config);
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
      thinking: wantsThinking && caps.thinking !== 'none' ? true : undefined,
      timeoutMs: req.timeoutMs ?? config.providers[name]?.timeoutMs ?? config.defaults.timeoutMs,
    };

    return { request, degradations, rendered };
  }

  /** Call the provider, re-checking spend before every attempt (retries included). */
  async function callProvider(
    resolved: Resolved,
    request: NormalizedRequest,
    signal: AbortSignal | undefined,
  ): Promise<ProviderResult> {
    // The messages count too — and they GROW on every repair turn, since each
    // one appends the model's bad answer plus the validation errors. Estimating
    // from the system prompt alone would under-count exactly the loop we most
    // need to catch.
    const inputChars =
      request.system.reduce((sum, block) => sum + block.text.length, 0) +
      request.messages.reduce((sum, message) => sum + message.content.length, 0);
    const estimate = estimateMaxCost({
      inputTokens: Math.ceil(inputChars / 4),
      maxTokens: request.maxTokens,
      pricing: priceFor(resolved),
    });

    return withRetry(() => resolved.provider.generate(request, signal), {
      maxAttempts: (config.providers[resolved.name]?.maxRetries ?? 2) + 1,
      logger,
      // THE invariant: every attempt re-enters the spend guard. A retry storm
      // and a repair loop both spend real money, and neither is covered by a
      // single check at the top of the call.
      onAttempt: () => spend.check(estimate),
    });
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
      metrics?.counter('ai.cost_unknown', 1, labels);
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
      });

    if (cacheEnabled) {
      const hit = responseCache.get<AiResult<string>>(cacheKey);
      if (hit) {
        metrics?.counter('ai.response_cache.hit', 1, { provider: resolved.name });
        return { ...hit, cached: 'response' };
      }
    }

    const run = async (): Promise<AiResult<string>> => {
      const result = await callProvider(resolved, request, req.signal);
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

    const output = cacheEnabled ? await responseCache.inFlight(cacheKey, run) : await run();
    if (cacheEnabled) {
      responseCache.set(
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
      const result = await callProvider(resolved, attemptRequest, req.signal);
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
        const result = await callProvider(resolved, request, req.signal);
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

    spend.check(
      estimateMaxCost({
        inputTokens: Math.ceil(
          request.system.reduce((sum, block) => sum + block.text.length, 0) / 4,
        ),
        maxTokens: request.maxTokens,
        pricing: priceFor(resolved),
      }),
    );
    const providerStream = resolved.provider.stream(request, req.signal);

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AiStreamEvent> {
        for await (const event of providerStream) {
          yield event;
        }
        const final = await providerStream.finalResult();
        yield { type: 'done', stopReason: final.stopReason };
      },
      async finalResult(): Promise<AiResult<string>> {
        finalPromise ??= providerStream.finalResult().then(toResult);
        return finalPromise;
      },
    };
  }

  // -------------------------------------------------------------------------

  async function generateStructuredInBackground<T>(
    req: AiStructuredRequest<T>,
  ): Promise<AiBackgroundHandle<AiResult<T>>> {
    // `slingshot-orchestration` integration (durable, retried, survives a
    // restart) is F4. Until then this runs inline — and SAYS SO, via the
    // discriminated handle. A caller cannot mistake a synchronous run for a
    // queued one, which is the entire reason the handle is a union.
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
