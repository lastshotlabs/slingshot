/**
 * Configuration for `slingshot-ai`.
 *
 * Note the deliberate absence of a top-level `.superRefine()`:
 * `validatePluginConfig` is typed `<S extends z.ZodObject>` and
 * `warnUnknownPluginKeys` introspects the object shape, so a refinement wrapper
 * would break both. Cross-field checks live in `createAiPackage()` as plain
 * imperative throws — which also produces better error messages.
 */
import { z } from 'zod';
import type { AiModerator } from './types';
import type { AiLogger, AiProvider, ModelPricing, ProviderCapabilities } from './provider/types';

/** A factory for a custom provider — the escape hatch for anything not built in. */
export type ProviderFactory = (
  name: string,
  config: AiProviderConfig,
  deps: { apiKey: string | null; logger: AiLogger },
) => AiProvider | Promise<AiProvider>;

const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});

const providerCapabilitiesSchema = z.object({
  structuredOutput: z.enum(['native', 'json-mode', 'none']),
  promptCaching: z.enum(['explicit', 'automatic', 'none']),
  promptCacheMinTokens: z.number().int().positive().optional(),
  streaming: z.boolean(),
  thinking: z.enum(['adaptive', 'budget', 'none']),
  effort: z.boolean(),
  usageAccounting: z.enum(['full', 'partial', 'none']),
  costAccounting: z.boolean(),
  refusalSignal: z.boolean(),
  toolUse: z.boolean(),
  maxOutputTokens: z.number().int().positive(),
});

export const aiProviderConfigSchema = z.object({
  /** Registry kind. Defaults to the provider's config key. */
  kind: z.string().optional(),
  /**
   * NAME of the secret holding the API key, resolved via `ctx.secrets.get()`.
   * Never the value itself — the framework resolves secrets at startup.
   */
  apiKeySecret: z.string().optional(),
  /** Literal key. Allowed (an app's own config may come from a secret store) but discouraged. */
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  /**
   * Capability overrides. In practice REQUIRED for `openai-compatible`, because
   * the same adapter fronts backends that range from vLLM+outlines (native
   * schema enforcement) to a small Ollama model (no JSON guarantee at all).
   */
  capabilities: providerCapabilitiesSchema.partial().optional(),
  /** `'free'` marks a zero-cost local provider; otherwise a per-model price table. */
  pricing: z.union([z.literal('free'), z.record(z.string(), modelPricingSchema)]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  /** Escape hatch: build a provider we don't ship. */
  createProvider: z.custom<ProviderFactory>(v => typeof v === 'function').optional(),
  /** DI escape hatch: hand us a ready-made provider (tests). */
  provider: z.custom<AiProvider>(v => typeof v === 'object' && v !== null).optional(),
});

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

const moderationPolicySchema = z.object({
  /** App-supplied policy text. This is the thing the moderator is actually asked to apply. */
  rules: z.string().min(1),
  categories: z.array(z.string()).min(1),
  blockAtOrAbove: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const aiPackageConfigSchema = z.object({
  providers: z.record(z.string(), aiProviderConfigSchema),
  defaultProvider: z.string(),

  defaults: z
    .object({
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      maxTokens: z.number().int().positive().default(4096),
      thinking: z.boolean().optional(),
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .prefault({}),

  /**
   * What to do when a provider cannot honor a request.
   * - `strict` — throw `AiUnsupportedFeatureError`.
   * - `warn`   — degrade, record an `AiDegradation`, log once. (default)
   * - `silent` — degrade and record, but don't log.
   *
   * Note that even `silent` still RECORDS the degradation on the result. There
   * is no mode in which the package lies about what it did.
   */
  degradation: z.enum(['strict', 'warn', 'silent']).default('warn'),

  structuredFallback: z
    .object({
      maxRepairAttempts: z.number().int().min(0).max(3).default(2),
    })
    .prefault({}),

  promptCache: z
    .object({
      enabled: z.boolean().default(true),
      /** Emit the drift/zero-hit warnings. Apps set `false` in prod once they trust it. */
      devWarnings: z.boolean().default(true),
      zeroHitWarnAfter: z.number().int().positive().default(3),
    })
    .prefault({}),

  responseCache: z
    .object({
      /** OFF by default: a party game wants variety, not a cached identical deck. */
      enabled: z.boolean().default(false),
      store: z.enum(['memory', 'redis', 'sqlite', 'postgres', 'mongo']).default('memory'),
      ttlSeconds: z.number().int().positive().default(3600),
      /** Collapse concurrent identical in-flight requests into one upstream call. */
      coalesce: z.boolean().default(true),
    })
    .prefault({}),

  moderation: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * `independent` (default) — a second call, on a cheap model, possibly to a
       * DIFFERENT provider. `self` — the generator emits its own verdict field;
       * cheaper and faster, but it is the model grading its own homework, and
       * it is defeated by one injected `{"safe": true}`. Documented as weaker.
       * `both` — run both and log disagreement (useful while tuning a policy).
       */
      strategy: z.enum(['independent', 'self', 'both']).default('independent'),
      /** MAY differ from the generation provider — generate local, moderate on a trusted model. */
      provider: z.string().optional(),
      model: z.string().optional(),
      policies: z.record(z.string(), moderationPolicySchema).default({}),
      /** Fail CLOSED. A safety control that fails open is not a safety control. */
      onError: z.enum(['block', 'allow']).default('block'),
      maxBatchSize: z.number().int().positive().default(25),
      /** Injection point: a non-LLM classifier, or a fake in tests. */
      moderator: z.custom<AiModerator>(v => typeof v === 'object' && v !== null).optional(),
    })
    .prefault({}),

  usage: z
    .object({
      enabled: z.boolean().default(true),
      persist: z.boolean().default(true),
      tagKeys: z.array(z.string()).default([]),
      retentionDays: z.number().int().positive().optional(),
    })
    .prefault({}),

  spend: z
    .object({
      enabled: z.boolean().default(true),
      period: z.enum(['hour', 'day', 'month']).default('day'),
      softLimitUsd: z.number().positive().optional(),
      hardLimitUsd: z.number().positive().optional(),
      refreshMs: z.number().int().positive().default(60_000),
      onSoftLimit: z.custom<(status: unknown) => void>(v => typeof v === 'function').optional(),
    })
    .prefault({}),

  logger: z.custom<AiLogger>(v => typeof v === 'object' && v !== null).optional(),
});

export type AiPackageConfig = z.infer<typeof aiPackageConfigSchema>;
export type AiPackageConfigInput = z.input<typeof aiPackageConfigSchema>;
export type ResolvedProviderCapabilities = ProviderCapabilities;
export type { ModelPricing };
