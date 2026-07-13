/**
 * `createAiPackage()` — the package factory.
 */
import type { PluginSetupContext, SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import {
  createConsoleLogger,
  getContext,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { type AiPackageConfig, type AiPackageConfigInput, aiPackageConfigSchema } from './config';
import { AiConfigError } from './errors';
import { createAiClient, type AiRuntime } from './lib/client';
import { buildProvider } from './provider/registry';
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
import type { AiLogger, AiProvider } from './provider/types';

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

  return Ai.definePackage({
    dependencies: [],
    entities: [],

    capabilities: {
      provides: [
        provideCapability(AiClientCap, () => clientFacade),
        provideCapability(AiModerationCap, () => moderatorFacade),
        provideCapability(AiUsageCap, () => usageFacade),
      ],
    },

    async setupMiddleware({ app }: PluginSetupContext) {
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

      runtime = createAiClient({ config, providers, logger, metrics: ctx.metricsEmitter });
    },

    async teardown() {
      runtime = undefined;
    },
  });
}
