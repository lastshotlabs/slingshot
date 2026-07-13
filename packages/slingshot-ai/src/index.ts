/**
 * `@lastshotlabs/slingshot-ai`
 *
 * Provider-neutral AI generation for slingshot apps: one client surface, honest
 * capability degradation, structured output that works even on providers that
 * don't support it, and cost/spend accounting that never invents a number.
 *
 * ```ts
 * const ai = ctx.capabilities.require(AiClientCap);
 * const { value, degradations } = await ai.generateStructured({
 *   schema: DeckSchema,
 *   system: { stable: [{ id: 'rules', text: RULES }], volatile: [{ id: 'seed', text: seed }] },
 *   messages: [{ role: 'user', content: 'Generate a deck.' }],
 * });
 * ```
 */
export { createAiPackage, AI_PACKAGE_NAME } from './plugin';
export { Ai, AiClientCap, AiModerationCap, AiUsageCap } from './public';

export {
  aiPackageConfigSchema,
  aiProviderConfigSchema,
  type AiPackageConfig,
  type AiPackageConfigInput,
  type AiProviderConfig,
  type ProviderFactory,
} from './config';

export {
  AiError,
  AiConfigError,
  AiProviderError,
  AiRateLimitError,
  AiRefusalError,
  AiStructuredOutputError,
  AiContentBlockedError,
  AiSpendLimitError,
  AiUnsupportedFeatureError,
  AiTimeoutError,
  type AiErrorCode,
} from './errors';

export type {
  AiBackgroundHandle,
  AiClient,
  AiDegradableFeature,
  AiDegradation,
  AiEffort,
  AiItemVerdict,
  AiMessage,
  AiModerationRequest,
  AiModerator,
  AiProviderInfo,
  AiRequestBase,
  AiResult,
  AiSeverity,
  AiStopReason,
  AiStream,
  AiStreamEvent,
  AiStructuredRequest,
  AiTags,
  AiUsage,
  AiUsageFilter,
  AiUsageReader,
  AiUsageRecordView,
  AiUsageSummary,
  AiVerdict,
  CachedSystem,
  ModelPricing,
  SpendStatus,
  SystemPrompt,
  SystemSegment,
} from './types';

export type {
  AiLogger,
  AiProvider,
  NormalizedRequest,
  NormalizedStructured,
  ProviderCapabilities,
  ProviderDeps,
  ProviderResult,
  ProviderStream,
  ProviderStreamEvent,
  ProviderUsage,
  RenderedSystemBlock,
  StructuredMode,
} from './provider/types';

export {
  CONSERVATIVE_CAPABILITIES,
  assertCapabilitiesConsistent,
  resolveCapabilities,
} from './provider/capabilities';

export {
  buildProvider,
  builtinProviderKinds,
  registerBuiltinProvider,
} from './provider/registry';

export { DEFAULT_PRICING } from './lib/pricing';
