/**
 * `createAiPackage()` — the package factory.
 */
import type { PluginSetupContext, SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  getCacheAdapterOrNull,
  getContext,
  maybeEntityAdapter,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { entity } from '@lastshotlabs/slingshot-entity';
import { type AiPackageConfig, type AiPackageConfigInput, aiPackageConfigSchema } from './config';
import { AiUsageRecord } from './entities/aiUsage';
import { AiConfigError } from './errors';
// Side-effect import: declares `ai:spend.soft_limit` on the SlingshotEventMap.
import './events';
import { backgroundSchemasFor } from './lib/backgroundRegistry';
import { type AiBackgroundRunner, type AiRuntime, createAiClient } from './lib/client';
import type { AiUsageRow, AiUsageStore } from './lib/seams';
// Side-effect import: registers the built-in adapters ('anthropic',
// 'openai-compatible', 'openai') in the provider registry. Neither adapter pulls
// an SDK at import time — the Anthropic one loads its SDK lazily in its factory.
import './provider/builtin';
import { buildProvider } from './provider/registry';
import type { AiLogger, AiProvider } from './provider/types';
import { Ai, AiClientCap, AiModerationCap, AiUsageCap } from './public';
import type {
  AiBackgroundHandle,
  AiClient,
  AiModerator,
  AiProviderInfo,
  AiRequestBase,
  AiResult,
  AiStream,
  AiStructuredRequest,
  AiUsageFilter,
  AiUsageReader,
  AiVerdict,
  ProviderCapabilities,
  SpendStatus,
} from './types';

export const AI_PACKAGE_NAME = 'slingshot-ai';

/**
 * Cross-field validation.
 *
 * Imperative rather than a `.superRefine()` because `validatePluginConfig` is
 * typed `<S extends z.ZodObject>` and `warnUnknownPluginKeys` introspects the
 * object shape — a refinement wrapper would break both. The error messages are
 * better this way anyway.
 */
function assertConfigCoherent(config: AiPackageConfig): void {
  const providerNames = Object.keys(config.providers);
  if (providerNames.length === 0) {
    throw new AiConfigError('At least one provider must be configured in `providers`.');
  }
  if (!providerNames.includes(config.defaultProvider)) {
    throw new AiConfigError(
      `defaultProvider '${config.defaultProvider}' is not a configured provider. ` +
        `Configured: ${providerNames.join(', ')}.`,
    );
  }
  const moderationProvider = config.moderation.provider;
  if (moderationProvider && !providerNames.includes(moderationProvider)) {
    throw new AiConfigError(
      `moderation.provider '${moderationProvider}' is not a configured provider. ` +
        `Configured: ${providerNames.join(', ')}.`,
    );
  }
  const { softLimitUsd, hardLimitUsd } = config.spend;
  if (softLimitUsd !== undefined && hardLimitUsd !== undefined && softLimitUsd >= hardLimitUsd) {
    throw new AiConfigError(
      `spend.softLimitUsd (${softLimitUsd}) must be less than spend.hardLimitUsd (${hardLimitUsd}).`,
    );
  }
}

/**
 * Create the `slingshot-ai` package.
 *
 * Two framework contracts shape this file:
 *
 * 1. **Secrets.** Each provider's API key is resolved from the framework secret
 *    repository during `setupMiddleware` — never from `process.env` — and a
 *    provider that declares a key it cannot get fails the BOOT. A party should
 *    not discover a missing API key at the moment the first player taps a button.
 *
 * 2. **Capability publication is declarative.** The framework resolves the
 *    values in `capabilities.provides` EAGERLY, at `publishPackageRuntimeState`,
 *    which runs *before* this package's `setupMiddleware` — so the real client
 *    does not exist yet at resolution time. Publishing imperatively instead
 *    doesn't work either: the framework re-runs its declarative pass at the top
 *    of `setupPost` and wipes the slot. The way through (precedent:
 *    `slingshot-notifications`) is to publish stable FACADES whose methods defer
 *    to a ref that `setupMiddleware` fills in. Consumers get one identity-stable
 *    object for the package's lifetime, and a consumer that somehow reaches a
 *    method before boot completes gets a precise error rather than `undefined`.
 */
export function createAiPackage(rawConfig: AiPackageConfigInput): SlingshotPackageDefinition {
  const config: AiPackageConfig = validatePluginConfig(
    AI_PACKAGE_NAME,
    rawConfig,
    aiPackageConfigSchema,
  );
  assertConfigCoherent(config);

  const logger: AiLogger =
    config.logger ?? createConsoleLogger({ base: { plugin: AI_PACKAGE_NAME } });

  let runtime: AiRuntime | undefined;

  function live(): AiRuntime {
    if (!runtime) {
      throw new AiConfigError(
        `slingshot-ai was used before it finished starting up. Resolve AiClientCap from ` +
          `setupPost or later (or from a request), not from setupMiddleware of a package that ` +
          `does not declare 'slingshot-ai' in its dependencies.`,
      );
    }
    return runtime;
  }

  const clientFacade: AiClient = {
    generate: (req: AiRequestBase) => live().client.generate(req),
    generateStructured: <T>(req: AiStructuredRequest<T>): Promise<AiResult<T>> =>
      live().client.generateStructured(req),
    stream: (req: AiRequestBase): AiStream => live().client.stream(req),
    generateStructuredInBackground: <T>(
      req: AiStructuredRequest<T>,
    ): Promise<AiBackgroundHandle<AiResult<T>>> =>
      live().client.generateStructuredInBackground(req),
    capabilitiesOf: (provider?: string): ProviderCapabilities =>
      live().client.capabilitiesOf(provider),
    providers: (): readonly AiProviderInfo[] => live().client.providers(),
    countTokens: (req: Pick<AiRequestBase, 'system' | 'messages' | 'model' | 'provider'>) =>
      live().client.countTokens(req),
  };

  const moderatorFacade: AiModerator = {
    moderate: (req: Parameters<AiModerator['moderate']>[0]): Promise<AiVerdict> =>
      live().moderator.moderate(req),
    policies: (): readonly string[] => live().moderator.policies(),
  };

  const usageFacade: AiUsageReader = {
    summary: (filter?: AiUsageFilter) => live().usage.summary(filter),
    spend: (): Promise<SpendStatus> => live().usage.spend(),
    records: (filter?: AiUsageFilter) => live().usage.records(filter),
  };

  // The usage entity's adapter and the orchestration runtime only exist from
  // `setupPost` onward, but the client is built in `setupMiddleware`. Rather
  // than defer the client (which would leave `AiClientCap` dead during other
  // packages' `setupPost`), the client is handed LATE-BOUND views that no-op
  // until the real thing lands. Same shape as the capability facades above, and
  // for the same reason.
  let usageAdapter: {
    create?(input: Record<string, unknown>): Promise<unknown>;
    find?(filter: Record<string, unknown>): Promise<unknown>;
  } | null = null;

  const lateStore: AiUsageStore = {
    async write(row: AiUsageRow): Promise<void> {
      if (!usageAdapter?.create) return;
      await usageAdapter.create({
        provider: row.provider,
        model: row.model,
        operation: row.operation,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        costUsd: row.costUsd,
        latencyMs: row.latencyMs,
        tags: row.tags,
        createdAt: row.createdAt,
      });
    },

    async since(since: Date): Promise<readonly AiUsageRow[]> {
      if (!usageAdapter?.find) return [];
      const found = await usageAdapter.find({ createdAt: { $gte: since } });
      const rows = (
        Array.isArray(found) ? found : ((found as { items?: unknown[] })?.items ?? [])
      ) as Record<string, unknown>[];

      return rows.map(row => ({
        provider: String(row.provider ?? ''),
        model: String(row.model ?? ''),
        operation: String(row.operation ?? ''),
        inputTokens: Number(row.inputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
        cacheReadTokens: Number(row.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
        // The nullability is the whole point — `?? 0` here would turn every
        // unpriced call into a free one and quietly under-count the budget the
        // spend guard is about to enforce.
        costUsd: row.costUsd === null || row.costUsd === undefined ? null : Number(row.costUsd),
        latencyMs: Number(row.latencyMs ?? 0),
        tags: (row.tags as Record<string, string> | null) ?? null,
        createdAt: new Date(row.createdAt as string | number | Date),
      }));
    },
  };

  let orchestration: {
    runTask(name: string, input: unknown): Promise<{ id: string }>;
  } | null = null;

  const lateBackground: AiBackgroundRunner = {
    // False until orchestration is both enabled AND resolved AND the schema is
    // registered with the task. Any of those missing → the client runs inline
    // and reports `{ mode: 'sync' }` rather than enqueueing a job that could
    // only fail on pickup.
    supports: (schemaName: string) =>
      orchestration !== null && backgroundSchemasFor(config.orchestration.taskName).has(schemaName),

    async enqueue(req): Promise<string> {
      if (!orchestration) {
        throw new AiConfigError(
          'Background generation was requested before orchestration resolved.',
        );
      }
      const handle = await orchestration.runTask(config.orchestration.taskName, req);
      return handle.id;
    },
  };

  return Ai.definePackage({
    dependencies: [],
    // The ledger. It declares NO `routes`, which is what makes its HTTP surface
    // empty — see `src/entities/aiUsage.ts`, and the boot test that pins it.
    entities: [entity({ config: AiUsageRecord })],

    capabilities: {
      provides: [
        provideCapability(AiClientCap, () => clientFacade),
        provideCapability(AiModerationCap, () => moderatorFacade),
        provideCapability(AiUsageCap, () => usageFacade),
      ],
    },

    async setupMiddleware({ app, bus }: PluginSetupContext) {
      const ctx = getContext(app);
      const providers = new Map<string, AiProvider>();

      for (const [name, providerConfig] of Object.entries(config.providers)) {
        // Secret NAME → value, through the framework's secret repository.
        let apiKey: string | null = providerConfig.apiKey ?? null;
        if (!apiKey && providerConfig.apiKeySecret) {
          apiKey = await ctx.secrets.get(providerConfig.apiKeySecret);
          if (!apiKey) {
            throw new AiConfigError(
              `Provider '${name}' declares apiKeySecret '${providerConfig.apiKeySecret}', ` +
                `but no such secret is available. Set it in the app's secret store before boot — ` +
                `a missing key must not surface mid-request.`,
            );
          }
        }

        providers.set(name, await buildProvider(name, providerConfig, { apiKey, logger }));
      }

      runtime = createAiClient({
        config,
        providers,
        logger,
        metrics: ctx.metricsEmitter,
        bus,
        store: config.usage.persist ? lateStore : null,
        cache: getCacheAdapterOrNull(app, config.responseCache.store),
        background: config.orchestration.enabled ? lateBackground : null,
      });
    },

    async setupPost({ app }: PluginSetupContext) {
      // Entity adapters are published during `setupRoutes`, so this is the
      // earliest phase in which the ledger is readable.
      usageAdapter = maybeEntityAdapter(app, {
        plugin: AI_PACKAGE_NAME,
        entity: 'AiUsageRecord',
      });

      if (config.orchestration.enabled) {
        // Lazy + guarded: `@lastshotlabs/slingshot-orchestration` is an optional
        // peer, and an app that never asked for background generation must not
        // be forced to install it.
        try {
          const [{ OrchestrationRuntimeCap }, { resolveCapabilityValue }] = await Promise.all([
            import('@lastshotlabs/slingshot-orchestration'),
            import('@lastshotlabs/slingshot-core'),
          ]);
          const resolved = resolveCapabilityValue(getContext(app), OrchestrationRuntimeCap);
          orchestration = (resolved as typeof orchestration) ?? null;
        } catch {
          orchestration = null;
        }

        if (!orchestration) {
          // Loud, because the app explicitly asked for durable background
          // generation and is not getting it. Silently running inline would look
          // identical right up until a restart lost someone's deck.
          logger.warn(
            `ai: orchestration.enabled is true, but no orchestration runtime is available. ` +
              `Background generation will run INLINE (and report { mode: 'sync' }). Install ` +
              `@lastshotlabs/slingshot-orchestration and register the task from ` +
              `@lastshotlabs/slingshot-ai/orchestration.`,
          );
        }
      }

      // Rebuild the spend window from the ledger. Without this a crash-loop
      // would hand the app a fresh budget on every boot — the exact failure a
      // hard limit exists to prevent.
      await runtime?.usage.hydrateSpend();
    },

    async teardown() {
      runtime = undefined;
      usageAdapter = null;
      orchestration = null;
    },
  });
}
