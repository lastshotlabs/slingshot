// Declares `ai:spend.soft_limit` on the SlingshotEventMap.
import './events';

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

// The usage ledger entity. Exported so an app can mount its OWN admin route
// over it — the package deliberately publishes none (see entities/aiUsage.ts).
export { AiUsageRecord } from './entities/aiUsage';

export type { AiCacheAdapter, AiEventBus, AiUsageRow, AiUsageStore } from './lib/seams';

export {
  aiPackageConfigSchema,
  aiProviderConfigSchema,
  type AiPackageConfig,
  type AiPackageConfigInput,
  type AiPluginConfig,
  type AiPluginConfigInput,
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
  AiContentPart,
  AiDegradableFeature,
  AiDegradation,
  AiEffort,
  AiItemVerdict,
  AiImagePart,
  AiMessage,
  AiMessageContent,
  AiModerationRequest,
  AiModerator,
  AiProviderInfo,
  AiRequestBase,
  AiResult,
  AiSeverity,
  AiSpendController,
  AiSpendReservation,
  AiSpendReservationRequest,
  AiSpendSettlement,
  AiStopReason,
  AiStream,
  AiStreamEvent,
  AiStructuredRequest,
  AiTags,
  AiTextPart,
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

export { buildProvider, builtinProviderKinds, registerBuiltinProvider } from './provider/registry';

// Built-in adapters. Importing this module registers the 'anthropic',
// 'openai-compatible', and 'openai' kinds; neither adapter pulls an SDK at
// import time, so this is free for an app that uses only one of them.
export {
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
} from './provider/builtin';

export { DEFAULT_PRICING } from './lib/pricing';

// Structured-output internals — exported because an adapter (F3) needs them to
// build its native payload, and because they are independently testable.
export {
  chooseStructuredMode,
  extractJson,
  parseStructured,
  sanitizeJsonSchema,
  toJsonSchema,
} from './lib/structured';
