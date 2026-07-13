/**
 * The orchestrator.
 *
 * Every call, on every provider, walks the same path:
 *
 *   negotiate capabilities → render system (prompt cache) → spend guard
 *     → response cache → provider call → refusal check → **validate**
 *     → moderation → usage + metrics → AiResult
 *
 * The load-bearing word is *validate*. `ProviderResult.structured` is ADVISORY:
 * Anthropic can hand back `parsed_output: null` on a refusal, and a "native"
 * OpenAI-compatible endpoint can simply be lying about its schema enforcement.
 * So the orchestrator re-validates with `schema.safeParse()` for EVERY provider.
 * That is the only reason an app can swap providers in config and not in code.
 *
 * The other rule: the package never silently does less than you asked. Anything
 * it cannot honor becomes an `AiDegradation` on the result (and, under
 * `degradation: 'strict'`, an `AiUnsupportedFeatureError` instead).
 *
 * Scope note (F1): a provider that reports `structuredOutput: 'none'` is
 * REFUSED here rather than served badly. The prompt-injected schema path, the
 * bounded JSON repair loop, and the retry layer land in F2 — at which point
 * `callProvider` and `generateStructured` grow those layers and nothing else in
 * this file changes.
 */
import { z } from 'zod';
import {
  AiConfigError,
  AiRefusalError,
  AiStructuredOutputError,
  AiUnsupportedFeatureError,
} from '../errors';
import type { AiPackageConfig } from '../config';
import type {
  AiLogger,
  AiProvider,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
} from '../provider/types';
import type {
  AiBackgroundHandle,
  AiClient,
  AiDegradation,
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
import { createSpendGuard } from './spend';
import { PromptCacheMonitor, renderSystem, type RenderedSystem } from './systemPrompt';
import { createUsageRecorder, type UsageRecorder } from './usage';

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
   * Everything common to every operation: capability negotiation, system
   * rendering, and the normalized request.
   */
  function prepare(
    req: AiRequestBase,
    resolved: Resolved,
  ): { request: NormalizedRequest; degradations: AiDegradation[]; rendered: RenderedSystem } {
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
      // Deliberately NOT routed through `degrade()`: an unpriced provider is a
      // fact about the deployment, not a request the caller made. Throwing here
      // under `strict` would make a local model unusable for anyone who wants
      // strict FEATURE negotiation. It is still recorded, and `costUsd` is null.
      degradations.push({
        feature: 'costAccounting',
        requested: 'usd',
        applied: 'tokens-only',
        reason: 'the provider does not report cost; usage.costUsd will be null',
      });
    }

    const request: NormalizedRequest = {
      model: resolved.model,
      system: rendered.blocks,
      messages: req.messages,
      maxTokens: Math.min(req.maxTokens ?? config.defaults.maxTokens, caps.maxOutputTokens),
      effort: wantsEffort && caps.effort ? wantsEffort : undefined,
      thinking: wantsThinking && caps.thinking !== 'none' ? true : undefined,
      timeoutMs: req.timeoutMs ?? config.providers[name]?.timeoutMs ?? config.defaults.timeoutMs,
    };

    return { request, degradations, rendered };
  }

  /** The worst case this call could cost — what the pre-flight guard checks. */
  function maxCostOf(resolved: Resolved, request: NormalizedRequest): number | null {
    const inputChars =
      request.system.reduce((sum, block) => sum + block.text.length, 0) +
      request.messages.reduce((sum, message) => sum + message.content.length, 0);
    return estimateMaxCost({
      inputTokens: Math.ceil(inputChars / 4),
      maxTokens: request.maxTokens,
      pricing: priceFor(resolved),
    });
  }

  /**
   * Call the provider, checking spend FIRST.
   *
   * Pre-flight, not post-hoc: a post-hoc check tells you about the runaway loop
   * only once it has finished spending the money. F2 wraps this call in the
   * retry layer, and the guard re-enters on every attempt.
   */
  async function callProvider(
    resolved: Resolved,
    request: NormalizedRequest,
    signal: AbortSignal | undefined,
  ): Promise<ProviderResult> {
    spend.check(maxCostOf(resolved, request));
    return resolved.provider.generate(request, signal);
  }

  function finishUsage(
    resolved: Resolved,
    result: ProviderResult,
    startedAt: number,
    operation: string,
    tags: Record<string, string> | undefined,
    rendered: RenderedSystem,
  ): AiUsage {
    const computed = computeUsage({
      usage: result.usage,
      pricing: priceFor(resolved),
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
    promptMonitor.recordCacheRead(
      rendered.promptCacheKey,
      result.usage.cacheReadTokens,
      rendered.breakpointEmitted,
    );

    const labels = { provider: resolved.name, model: resolved.model, operation };
    metrics?.counter('ai.calls', 1, labels);
    metrics?.counter('ai.tokens.input', computed.inputTokens, labels);
    metrics?.counter('ai.tokens.output', computed.outputTokens, labels);
    metrics?.timing('ai.latency', latencyMs, labels);
    if (computed.costUsd !== null) metrics?.counter('ai.cost_usd', computed.costUsd, labels);
    else metrics?.counter('ai.cost_unknown', 1, labels);

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
      // On Anthropic a refusal is HTTP 200 with an empty body. Treating that as
      // a successful empty generation is how you ship a blank card to a table of
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

    const verdict = await moderator.moderate({
      content: request.extract ? request.extract(value) : [text],
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
        { categories: verdict.categories, severity: verdict.severity, reason: verdict.reason },
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
      const computed = finishUsage(resolved, result, startedAt, 'generate', req.tags, rendered);
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

    if (caps.structuredOutput === 'none') {
      // An honest refusal beats a bad guess. F2 adds the prompt-injected schema
      // path and the bounded repair loop, which is what actually makes this work
      // on a provider with no structured-output support.
      throw new AiUnsupportedFeatureError(
        `Provider '${resolved.name}' declares no structured-output support, and the ` +
          `prompt-instructed fallback is not available in this build.`,
        { feature: 'structuredOutput', provider: resolved.name },
      );
    }

    const { request, degradations, rendered } = prepare(req, resolved);

    if (caps.structuredOutput === 'json-mode') {
      degrade(
        degradations,
        {
          feature: 'structuredOutput',
          requested: 'native',
          applied: 'json-mode',
          reason:
            'the provider guarantees valid JSON but does not enforce the schema; the result is ' +
            'validated locally',
        },
        resolved.name,
      );
    }

    const result = await callProvider(
      resolved,
      {
        ...request,
        structured: {
          name: schemaName,
          zod: req.schema,
          jsonSchema: z.toJSONSchema(req.schema, { io: 'output' }) as Record<string, unknown>,
          mode: caps.structuredOutput === 'native' ? 'native' : 'json-mode',
        },
      },
      req.signal,
    );
    checkRefusal(result, resolved, degradations);
    const computed = finishUsage(
      resolved,
      result,
      startedAt,
      'generateStructured',
      req.tags,
      rendered,
    );

    // THE single validation point. The provider's own parsed object is a HINT:
    // a "native" provider that got the shape wrong, and one that returned
    // `parsed_output: null`, both land here and both get caught.
    const advisory = result.structured;
    const candidate =
      advisory !== undefined && advisory !== null ? advisory : safeJsonParse(result.text);
    const parsed = req.schema.safeParse(candidate);

    if (!parsed.success) {
      metrics?.counter('ai.structured.failed', 1, { provider: resolved.name });
      throw new AiStructuredOutputError(
        `The model did not produce output matching schema '${schemaName}' on provider ` +
          `'${resolved.name}'. The raw text and the validation error are attached.`,
        { rawText: result.text, zodError: parsed.error, attempts: 1 },
      );
    }

    const moderation = await runModeration(req, parsed.data, result.text);
    return {
      value: parsed.data,
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

  // -------------------------------------------------------------------------

  function stream(req: AiRequestBase): AiStream {
    const startedAt = Date.now();
    const resolved = resolve(req);
    const { request, degradations, rendered } = prepare(req, resolved);

    let finalPromise: Promise<AiResult<string>> | undefined;

    const toResult = async (result: ProviderResult): Promise<AiResult<string>> => {
      checkRefusal(result, resolved, degradations);
      const computed = finishUsage(resolved, result, startedAt, 'stream', req.tags, rendered);
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

    // A non-streaming provider still honors the AsyncIterable contract: the
    // whole answer arrives as a single delta. The caller gets a correct stream
    // that simply isn't incremental — plus a degradation saying exactly that,
    // rather than a silent lie about interactivity.
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

      const once = async (): Promise<AiResult<string>> =>
        toResult(await callProvider(resolved, request, req.signal));

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

    spend.check(maxCostOf(resolved, request));
    const providerStream = resolved.provider.stream(request, req.signal);

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AiStreamEvent> {
        for await (const event of providerStream) yield event;
        const final = await providerStream.finalResult();
        yield { type: 'done', stopReason: final.stopReason };
      },
      finalResult(): Promise<AiResult<string>> {
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
    return { mode: 'sync', result: await generateStructured(req) };
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
      const { request } = prepare(req, resolved);
      return resolved.provider.countTokens(request);
    },
  };

  return { client, moderator, usage };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
