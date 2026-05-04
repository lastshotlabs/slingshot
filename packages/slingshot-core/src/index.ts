// Emit a one-time pre-1.0 stability warning for the entire framework.
// Deduplicated per-package per-stability-level across all Slingshot packages.
import { emitPackageStabilityWarning } from './stability';

/** Core plugin lifecycle contracts implemented by Slingshot feature packages. */
export type {
  SlingshotPlugin,
  StandalonePlugin,
  PluginSetupContext,
  PluginSeedContext,
} from './plugin';
/** Runtime abstraction types used by Slingshot hosts and server bootstrap. */
export type {
  SlingshotRuntime,
  RuntimePassword,
  RuntimeSqliteDatabase,
  RuntimeSqliteStatement,
  RuntimeSqlitePreparedStatement,
  RuntimeSqliteRunResult,
  RuntimeFs,
  RuntimeGlob,
  RuntimeServerOptions,
  RuntimeWebSocketHandler,
  RuntimeWebSocket,
  RuntimeServerInstance,
  RuntimeServerFactory,
} from './runtime';
/** Event-bus contracts and event-key typing shared across framework packages. */
export type {
  SlingshotEventBus,
  SlingshotEventMap,
  DynamicEventBus,
  SecurityEventKey,
  SubscriptionOpts,
} from './eventBus';
export type {
  EventSerializer,
  EventBusSerializationOptions,
  ValidationMode,
} from './eventSerializer';
export { JsonEventSerializer, JSON_SERIALIZER } from './eventSerializer';
export type { EventSchemaRegistry, EventValidationResult } from './eventSchemaRegistry';
export { createEventSchemaRegistry, validateEventPayload } from './eventSchemaRegistry';
export type {
  EventDefinition,
  EventExposure,
  EventKey,
  EventPublishContext,
  EventScope,
  EventSubscriptionPrincipal,
} from './eventDefinition';
export {
  createDefaultSubscriberAuthorizer,
  defineEvent,
  eventHasExternalExposure,
  matchSubscriberToScope,
  validateEventDefinition,
} from './eventDefinition';
export type { EventEnvelope, EventEnvelopeMeta } from './eventEnvelope';
export { createEventEnvelope, createRawEventEnvelope, isEventEnvelope } from './eventEnvelope';
export type {
  EventDefinitionRegistry,
  EventDefinitionRegistryOptions,
} from './eventDefinitionRegistry';
export { createEventDefinitionRegistry } from './eventDefinitionRegistry';
export type { CreateEventPublisherOptions, SlingshotEvents } from './eventPublisher';
export { authorizeEventSubscriber, createEventPublisher } from './eventPublisher';
export type {
  KafkaConnectorDropStats,
  KafkaConnectorHandle,
  KafkaConnectorHealth,
  KafkaInboundConnectorHealth,
  KafkaOutboundConnectorHealth,
} from './kafkaConnectors';
/** In-process event bus primitives and the built-in client-safe event allowlist. */
export { InProcessAdapter, createInProcessAdapter, SECURITY_EVENT_TYPES } from './eventBus';
/** Adapter that normalizes router behavior across Slingshot runtimes. */
export { createRouterAdapter } from './routerAdapter';
export type { RouterAdapterOptions } from './routerAdapter';
/** Server-sent-event payload and endpoint contracts shared by realtime integrations. */
export type { SseClientData, SseFilter, SseEndpointConfig } from './sse';
/** Permission evaluation, grants, and adapter contracts used across access-control packages. */
export type {
  SubjectType,
  GrantEffect,
  SubjectRef,
  PermissionGrant,
  EvaluationScope,
  PermissionsAdapter,
  TestablePermissionsAdapter,
  ResourceTypeDefinition,
  PermissionRegistry,
  GroupResolver,
  PermissionEvaluator,
} from './permissions';
export {
  validateGrant,
  SUPER_ADMIN_ROLE,
  PERMISSIONS_STATE_KEY,
  PERMISSIONS_RUNTIME_KEY,
  getPermissionsState,
  getPermissionsStateOrNull,
} from './permissions';
export type { PermissionsState } from './permissions';
export type { RenderResult, MailRenderer } from './mail';
export { TemplateNotFoundError } from './mail';
/** Auth-adapter record and repository contracts shared by auth and admin packages. */
export type {
  IdentityProfile,
  WebAuthnCredential,
  M2MClientRecord,
  UserQuery,
  UserRecord,
  GroupRecord,
  GroupMembershipRecord,
  TenantScopedOpts,
  PaginationOptions,
  PaginatedResult,
  CoreAuthAdapter,
  OAuthAdapter,
  MfaAdapter,
  WebAuthnAdapter,
  RolesAdapter,
  GroupsAdapter,
  SuspensionAdapter,
  EnterpriseAdapter,
  AuthAdapter,
} from './auth-adapter';
/** OpenAPI-aware route builders used by framework and plugin packages. */
export {
  createRoute,
  withSecurity,
  registerSchema,
  registerSchemas,
  maybeAutoRegister,
} from './createRoute';
/** Package-first authoring contracts for capabilities, domains, and typed route builders. */
export {
  applyPublicEntityExposure,
  defineCapability,
  definePackage,
  definePackageContract,
  domain,
  entityRef,
  inspectPackage,
  PACKAGE_CAPABILITIES_PREFIX,
  provideCapability,
  route,
} from './packageAuthoring';
/** Out-of-request hook services contract — typed accessors for callbacks that fire outside Hono request scope. */
export { buildHookServices } from './hookServices';
export type { HookServices } from './hookServices';
export type {
  ContractDefinePackageInput,
  DefinePackageInput,
  DomainRouteDefinition,
  PackageCapabilityHandle,
  PackageCapabilityProviderContext,
  PackageCapabilityReader,
  PackageContract,
  PackageContractMetadata,
  PackageDomainRouteContext,
  PackageEntityRef,
  PackageEntityReader,
  PackageInspection,
  PackageRouteRequestContext,
  PublicEntityBuilder,
  PublicEntityCandidate,
  PublicEntityExposureMetadata,
  PublicEntityExposureMode,
  PublishedCapabilityRecord,
  PublishedEntityRecord,
  PublishedPackageCapability,
  SlingshotPackageDefinition,
  SlingshotPackageDomainModule,
  SlingshotPackageEntityModuleLike,
  SlingshotPackageModule,
  TypedRouteContext,
  TypedRouteInput,
  TypedRouteRequestSpec,
  TypedRouteRespond,
  TypedRouteResponseSpec,
  TypedRouteResponses,
  TypedRouteValidation,
} from './packageAuthoring';
/** Offset and cursor pagination helpers shared by generated and handwritten routes. */
export { offsetParams, parseOffsetParams, paginatedResponse } from './pagination';
export { cursorParams, parseCursorParams, cursorPaginatedResponse } from './pagination';
export type { OffsetParamDefaults, ParsedOffsetParams } from './pagination';
export type { CursorParamDefaults, ParsedCursorParams } from './pagination';
/** Audit, captcha, and CSRF contracts consumed by auth and framework middleware. */
export type { AuditLogEntry, AuditLogQuery, AuditLogProvider } from './auditLog';
export type { CaptchaProvider, CaptchaConfig } from './captcha';
export type { CsrfConfig } from './csrf';

// --- errors ---
/** Framework error types used for HTTP, validation, and adapter capability failures. */
export {
  SlingshotError,
  HttpError,
  ValidationError,
  UnsupportedAdapterFeatureError,
} from './errors';
export { errorResponse } from './errorResponse';

// --- path safety ---
/**
 * Helpers for confining filesystem operations to a fixed base directory.
 * Use these whenever an externally-supplied value (URL pathname, manifest
 * route name, upload key) is concatenated with a directory before being
 * handed to `fs.*`.
 */
export { safeJoin, PathTraversalError } from './lib/safePath';
/** Transport-agnostic handler contracts shared across HTTP and functions runtimes. */
export type {
  HandlerMeta,
  HandlerArgs,
  HandlerConfig,
  InvokeOpts,
  SlingshotHandler,
  Guard,
  AfterHook,
} from './handler';
export { defineHandler, HandlerError, IdempotencyCacheHit, resolveActor } from './handler';
/** Trigger adapters and lifecycle hooks for non-HTTP runtimes such as Lambda. */
export type {
  TriggerRecord,
  RecordOutcome,
  TriggerAdapter,
  TriggerExtractedMeta,
  FunctionsHooks,
  BeforeInvokeArgs,
  AfterInvokeArgs,
  ErrorKind,
  OnErrorArgs,
  ErrorDisposition,
  RecordErrorArgs,
  InvokeAbort,
  FunctionsRuntimeConfig,
  FunctionsRuntime,
  TriggerOpts,
  IdempotencyOpts,
} from './functions';

// --- utilities ---
export { deepFreeze } from './deepFreeze';
export { bestEffort } from './bestEffort';
export { encodeCursor, decodeCursor } from './cursor';
export { emitPackageStabilityWarning } from './stability';
export type { PackageStability } from './stability';
export {
  evaluateFilter,
  extractFilterParams,
  extractMatchParams,
  resolveMatch,
} from './filterEvaluator';

// --- crypto ---
/** Crypto and token helpers used by auth, signing, and secure request flows. */
export {
  sha256,
  hmacSign,
  timingSafeEqual,
  hashToken,
  encryptField,
  decryptField,
  isEncryptedField,
  generateSecureToken,
} from './crypto';
export type { DataEncryptionKey } from './crypto';

// --- constants ---
/** Shared request and cookie header constants used across Slingshot packages. */
export {
  COOKIE_TOKEN,
  HEADER_USER_TOKEN,
  COOKIE_REFRESH_TOKEN,
  HEADER_REFRESH_TOKEN,
  COOKIE_CSRF_TOKEN,
  HEADER_CSRF_TOKEN,
  HEADER_REQUEST_ID,
  HEADER_IDEMPOTENCY_KEY,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
} from './constants';

// --- signing ---
export type { SigningConfig } from './signing';

// --- redis ---
export type { RedisLike } from './redis';
export type {
  PostgresHealthCheckResult,
  PostgresMigrationMode,
  PostgresPoolRuntime,
  PostgresPoolStatsSnapshot,
} from './postgresRuntime';
export {
  attachPostgresPoolRuntime,
  createPostgresPoolRuntime,
  getPostgresPoolRuntime,
} from './postgresRuntime';

// --- clientIp ---
/** Client IP helpers for runtime-aware proxy and standalone request handling. */
export {
  getClientIp,
  getClientIpFromRequest,
  setStandaloneClientIp,
  setStandaloneTrustProxy,
} from './clientIp';

// --- identity ---
/** Actor-based identity abstraction for decoupling plugins from auth field names. */
export type { Actor, ActorKind, IdentityResolver, IdentityResolverInput } from './identity';
export { ANONYMOUS_ACTOR, createDefaultIdentityResolver } from './identity';
/** Request-context actor helpers for Hono middleware and routes. */
export { getActor, getActorId, getActorTenantId, getRequestTenantId } from './actorContext';

// --- auth peer ---
export type { AuthRuntimePeer, AuthUserAccessDecision, AuthUserAccessInput } from './authPeer';
export {
  AUTH_PLUGIN_STATE_KEY,
  evaluateAuthUserAccess,
  getAuthRuntimePeer,
  getAuthRuntimePeerOrNull,
} from './authPeer';
export {
  ASSETS_PLUGIN_STATE_KEY,
  CHAT_PLUGIN_STATE_KEY,
  COMMUNITY_PLUGIN_STATE_KEY,
  EMBEDS_PLUGIN_STATE_KEY,
  POLLS_PLUGIN_STATE_KEY,
  PUSH_PLUGIN_STATE_KEY,
} from './pluginKeys';

// --- storageAdapter ---
/** Upload storage adapter interfaces used by framework and media packages. */
export type { StorageAdapter, UploadResult } from './storageAdapter';

// --- idempotency ---
/** Idempotency repository contract for write endpoints and action handlers. */
export type { IdempotencyAdapter } from './idempotencyAdapter';
/** Operation-level idempotency contract for delivery/retry dedupe (mail, push, notifications, orchestration). */
export type { IdempotencyKey, WithIdempotencyOptions } from './idempotency/index';
export type { IdempotencyAdapter as OperationIdempotencyAdapter } from './idempotency/index';
export {
  createMemoryOperationIdempotencyAdapter,
  makeIdempotencyKey,
  withIdempotency,
} from './idempotency/index';

// --- uploadRegistry ---
/** Upload-registry persistence contracts for staged or completed file uploads. */
export type { UploadRecord, UploadRegistryRepository } from './uploadRegistry';

// --- wsMessages ---
/** Durable WebSocket message and room persistence contracts. */
export type {
  StoredMessage,
  WsMessageDefaults,
  RoomPersistenceConfig,
  WsMessageRepository,
} from './wsMessages';

// --- context (AppEnv, createRouter, validation) ---
/** Router-context helpers and default validation formatting for Slingshot apps. */
export {
  createRouter,
  defaultHook,
  defaultValidationErrorFormatter,
  getSlingshotCtx,
} from './context';
export type {
  AppEnv,
  AppVariables,
  ValidationErrorFormatter,
  DefaultValidationErrorBody,
  ValidationErrorDetail,
} from './context';

// --- memoryEviction ---
export {
  evictOldest,
  createEvictExpired,
  evictOldestArray,
  DEFAULT_MAX_ENTRIES,
} from './memoryEviction';

// --- Auth boundary contracts ---
export type { RequestActorResolver } from './requestActorResolver';
/** Access the auth-published request actor resolver from Slingshot context. */
export { getRequestActorResolver, getRequestActorResolverOrNull } from './requestActorResolver';

export type { PostAuthGuard, PostAuthGuardFailure, RouteAuthRegistry } from './routeAuth';
/** Access route-auth helpers published through the Slingshot registrar. */
export { getRouteAuth, getRouteAuthOrNull } from './routeAuth';

export type { RateLimitAdapter, FingerprintBuilder } from './rateLimit';
/** Access shared rate-limit and fingerprint services from Slingshot context. */
export { getRateLimitAdapter, getFingerprintBuilder } from './rateLimit';

export type { CacheAdapter, CacheStoreName } from './cache';
/** Access cache adapters published through the Slingshot registrar. */
export { getCacheAdapter, getCacheAdapterOrNull } from './cache';

export type { EmailTemplate } from './emailTemplates';
/** Access email templates registered by auth or other plugins. */
export { getEmailTemplates, getEmailTemplate } from './emailTemplates';

/** Neutral cross-plugin notifications contracts published via `ctx.pluginState`. */
export type {
  DeliveryAdapter,
  NotificationBuilder,
  NotificationCreatedEventPayload,
  NotificationPriority,
  NotificationRecord,
  NotificationsPeerState,
  NotifyInput,
  NotifyManyInput,
  ResolvedPreference,
} from './notificationsPeer';
export {
  NOTIFICATIONS_PLUGIN_STATE_KEY,
  getNotificationsState,
  getNotificationsStateOrNull,
} from './notificationsPeer';
export type { EmbedsPeer } from './embedsPeer';
export { getEmbedsPeer, getEmbedsPeerOrNull } from './embedsPeer';
export type { PushFormatterPeer, PushFormatterPeerFn, PushMessageLike } from './pushPeer';
export { getPushFormatterPeer, getPushFormatterPeerOrNull } from './pushPeer';
export type { PublishedInteractionsPeer } from './publishedInteractionsPeer';
export { getPublishedInteractionsPeerOrNull } from './publishedInteractionsPeer';

// --- pluginState ---
export type {
  EntityAdapterLookup,
  PluginStateCarrier,
  PluginStateKey,
  PluginStateMap,
} from './pluginState';
/** Shared `pluginState` helpers for cross-plugin runtime access without full context coupling. */
export {
  createPluginStateMap,
  definePluginStateKey,
  getPluginState,
  getPluginStateOrNull,
  getPluginStateFromRequest,
  getPluginStateFromRequestOrNull,
  isPluginStateSealed,
  maybeEntityAdapter,
  publishEntityAdaptersState,
  publishPluginState,
  readPluginState,
  requireEntityAdapter,
  requirePluginState,
  resolvePluginState,
  sealPluginState,
} from './pluginState';

// --- Auth boundary defaults ---
/** Default in-memory infrastructure adapters used by local and test deployments. */
export { createMemoryRateLimitAdapter } from './defaults/memoryRateLimit';
export { createDefaultFingerprintBuilder } from './defaults/defaultFingerprint';
export { createMemoryCacheAdapter } from './defaults/memoryCacheAdapter';

// --- configValidation ---
/** Validation helpers for plugin config, adapter shapes, and public route behavior. */
export {
  validatePluginConfig,
  validateAdapterShape,
  disableRoutesSchema,
} from './configValidation';
export { isPublicPath } from './publicPath';

// --- routeOverrides ---
export type { RouteKey } from './routeOverrides';
/** Utilities for stable entity-route keys and route-override checks. */
export { routeKey, shouldMountRoute } from './routeOverrides';

// --- SlingshotContext (instance-scoped state) ---
export type {
  SlingshotContext,
  SlingshotResolvedConfig,
  SlingshotFrameworkConfig,
  ResolvedStores,
  WsState,
  WsTransportHandle,
  WsRateLimitBucket,
  WsRateLimitConfig,
  WsRecoveryConfig,
  WsSessionEntry,
  UploadRuntimeState,
  ResolvedPersistence,
} from './context/index';
/** Attach and read the instance-scoped Slingshot context for a running app. */
export { attachContext, getContext, getContextOrNull, resolveContext } from './context/index';
export type { CoreRegistrar, CoreRegistrarSnapshot } from './coreRegistrar';
/** Create the registrar that plugins use to publish shared runtime capabilities during boot. */
export { createCoreRegistrar } from './coreRegistrar';

// --- Secrets ---
/** Secret storage contracts used by framework secret resolution and plugin consumers. */
export type {
  SecretRepository,
  SecretStoreType,
  SecretDefinition,
  SecretSchema,
  ResolvedSecrets,
} from './secrets';

// --- Queue lifecycle (shared contract for domain queues) ---
/** Queue lifecycle hooks used by packages that own background workers. */
export type { QueueLifecycle } from './queueLifecycle';

// --- Store type & infrastructure (shared across all slingshot packages) ---
export type { StoreType } from './storeType';
export type { CronRegistryRepository } from './cronRegistry';
/** Shared infrastructure and repository-factory contracts used during app assembly. */
export type {
  StoreInfra,
  RepoFactories,
  TestableRepoFactories,
  PostgresBundle,
} from './storeInfra';
/** Store-type resolution and plugin-facing DI symbols for infrastructure factories. */
export {
  resolveRepo,
  resolveRepoAsync,
  RESOLVE_ENTITY_FACTORIES,
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_REINDEX_SOURCE,
} from './storeInfra';

// --- Config-driven entity persistence (shared type contracts) ---
export type {
  FieldType,
  FieldTypeMap,
  FieldDef,
  FieldOptions,
  AutoDefault,
  IndexDef,
  RelationDef,
  SoftDeleteConfig,
  PaginationConfig,
  TenantConfig,
  EntityStorageHints,
  EntityTtlConfig,
  EntitySystemFields,
  EntityStorageFieldMap,
  ResolvedEntitySystemFields,
  ResolvedEntityStorageFieldMap,
  EntityStorageConventions,
  ResolvedEntityStorageConventions,
  CustomAutoDefaultResolver,
  CustomOnUpdateResolver,
  EntityConfig,
  EntityDtoConfig,
  EntityDtoMapper,
  ResolvedEntityConfig,
  InferEntity,
  InferFieldType,
  InferCreateInput,
  InferUpdateInput,
  CursorPaginationOptions,
  PaginatedResult as EntityPaginatedResult,
  EntityAdapter,
  EntitySearchConfig,
  SearchFieldConfig,
  GeoSearchConfig,
} from './entityConfig';
/** Entity-definition DSL primitives re-exported for cross-package authoring. */
export { defineEntity, field, index, relation } from './entityConfig';

// --- Entity registry ---
export type { EntityRegistry } from './entityRegistry';
/** Per-app registry of resolved entity config used by runtime discovery flows. */
export { createEntityRegistry } from './entityRegistry';

// --- Search provider contract (minimal, for write-through sync) ---
/** Minimal search-provider write contract used by entity and search packages. */
export type { SearchProviderContract } from './searchProvider';

// --- Search plugin runtime contract (framework ↔ search plugin) ---
export type {
  SearchPluginRuntime,
  SearchClientLike,
  SearchQueryLike,
  SearchResponseLike,
} from './searchPluginRuntime';
export {
  SEARCH_PLUGIN_STATE_KEY,
  getSearchPluginRuntime,
  getSearchPluginRuntimeOrNull,
} from './searchPluginRuntime';

// --- Config-driven operation types (shared between slingshot-data and framework) ---
/** Config-driven operation DSL types shared by generators, runtime executors, and route config. */
export type {
  FilterExpression,
  FilterValue,
  FilterOperator,
  FilterNe,
  FilterGt,
  FilterGte,
  FilterLt,
  FilterLte,
  FilterIn,
  FilterNin,
  FilterContains,
  ComputeSpec,
  ComputedField,
  DateTruncation,
  GroupByConfig,
  MergeStrategy,
  LookupOpConfig,
  ExistsOpConfig,
  TransitionOpConfig,
  FieldUpdateOpConfig,
  AggregateOpConfig,
  ComputedAggregateOpConfig,
  BatchOpConfig,
  UpsertOpConfig,
  SearchOpConfig,
  CollectionOpConfig,
  CollectionOperation,
  ConsumeOpConfig,
  DeriveOpConfig,
  DeriveSource,
  TransactionOpConfig,
  TransactionStep,
  PipeOpConfig,
  PipeStep,
  CustomOpConfig,
  ArrayPushOpConfig,
  ArrayPushMethod,
  ArrayPullOpConfig,
  ArrayPullMethod,
  ArraySetOpConfig,
  ArraySetMethod,
  IncrementOpConfig,
  IncrementMethod,
  OperationConfig,
  ResolvedOperations,
  InferOperationMethods,
} from './operations';

// --- Entity route config types ---
export type {
  EntityRouteConfig,
  RouteAuthConfig,
  RoutePermissionConfig,
  RouteRateLimitConfig,
  RouteIdempotencyConfig,
  RouteIdempotencyScope,
  RouteEventConfig,
  RouteOperationConfig,
  RouteNamedOperationConfig,
  NamedOpHttpMethod,
  EntityRouteDataScopeConfig,
  EntityRouteDataScopeSource,
  EntityDataScopedCrudOp,
  RouteWebhookConfig,
  RouteRetentionConfig,
  EntityPermissionConfig,
  RouteMiddlewareConfig,
  RouteCascadeConfig,
  PolicyAction,
  PolicyInput,
  PolicyDecision,
  PolicyResolver,
  PolicyToken,
  PolicyTokenRef,
  EntityRoutePolicyConfig,
} from './entityRouteConfig';
/** Resolve and validate config-driven entity route declarations. */
export {
  definePolicy,
  getPolicyResolverKey,
  isPolicyToken,
  resolveOpConfig,
} from './entityRouteConfig';
export { entityRouteConfigSchema, validateEntityRouteConfig } from './entityRouteConfigSchema';
export type { EntityRouteConfigInput } from './entityRouteConfigSchema';

// --- Entity channel config types ---
export type {
  EntityChannelConfig,
  EntityChannelDeclaration,
  ChannelAuthConfig,
  ChannelPermissionConfig,
  ChannelForwardConfig,
  ChannelReceiveConfig,
  ChannelIncomingEventDeclaration,
} from './entityChannelConfig';
/** Validate config-driven entity channel declarations for realtime wiring. */
export {
  entityChannelConfigSchema,
  validateEntityChannelConfig,
} from './entityChannelConfigSchema';
export type { EntityChannelConfigInput } from './entityChannelConfigSchema';
/** WebSocket helper utilities shared by config-driven channel infrastructure. */
export { isValidRoomName } from './wsHelpers';
export type { WsPublishFn, WsPluginEndpoint } from './wsHelpers';

// --- Admin provider contracts (shared between slingshot-admin and slingshot-auth) ---
/** Admin and managed-user contracts shared between auth and admin packages. */
export type {
  AdminPrincipal,
  AdminAccessProvider,
  ManagedUserRecord,
  ManagedUserScope,
  ListUsersInput,
  ListUsersResult,
  SuspendUserInput,
  UnsuspendUserInput,
  UpdateUserInput,
  SessionRecord,
  ManagedUserCapabilities,
  ManagedUserProvider,
} from './adminProvider';

/** Run first-party SQLite subsystem migrations during boot or tests. */
export { runSubsystemMigrations } from './sqliteMigrations';

// --- Content model types ---
/** Rich-content payload types used by chat, community, embeds, and renderer integrations. */
export type {
  ContentFormat,
  AssetRef,
  VoiceMetadata,
  EmbedData,
  QuotePreview,
  LocationData,
  ContactData,
  SystemEventData,
  ParsedContent,
  ContentSegment,
} from './content';
export { MAX_CONTENT_BODY_LENGTH, MAX_CONTENT_MENTIONS, MAX_CONTENT_ATTACHMENTS } from './content';
export {
  assetRefSchema,
  quotePreviewSchema,
  locationDataSchema,
  contactDataSchema,
  systemEventDataSchema,
} from './content.schemas';
export { generateFromSchema, generateMany, generateExample } from './faker';
export type { GenerateOptions } from './faker';

// --- metrics (unified emitter contract) ---
/** Pluggable metrics emitter contract used by prod-track packages. */
export type {
  MetricsEmitter,
  InProcessMetricsEmitter,
  MetricsSnapshot,
  CounterSnapshotEntry,
  GaugeSnapshotEntry,
  TimingSnapshotEntry,
} from './metrics';
export { createNoopMetricsEmitter, createInProcessMetricsEmitter } from './metrics';

// --- safe fetch (pinned-IP, SSRF-hardened fetch) ---
/** SSRF-hardened fetch helpers that resolve DNS once, validate the IP, and pin the connection. */
export {
  createSafeFetch,
  SafeFetchBlockedError,
  SafeFetchDnsError,
  isPrivateOrLoopbackIp,
} from './http/safeFetch';
export type { SafeFetchOptions } from './http/safeFetch';

// --- header / log sanitization (CRLF injection guards) ---
/** CRLF / NUL injection guards for HTTP, email, queue, and log sinks. */
export { HeaderInjectionError, sanitizeHeaderValue, sanitizeLogValue } from './lib/sanitize';

// --- concurrency primitives (timeouts) ---
/** Promise and AbortSignal timeout helpers used to bound external I/O. */
export { TimeoutError, timeoutSignal, withTimeout } from './concurrency/withTimeout';

// --- observability: structured logger ---
/** Structured logger contract and default console-backed implementation. */
export { createConsoleLogger, noopLogger } from './observability/logger';
export type { Logger, LogLevel, LogFields } from './observability/logger';

// --- observability: health checks ---
/** Per-component health-check contract used by framework-level aggregators. */
export type {
  HealthAppConfig,
  HealthCheck,
  HealthIndicator,
  HealthIndicatorContext,
  HealthIndicatorResult,
  HealthIndicatorSeverity,
  HealthReport,
  HealthState,
} from './observability/health';
export { defineHealthIndicator } from './observability/health';

// --- request-scoped state ---
export type { RequestScope, RequestScopeContext, RequestScopeStore } from './requestScope';
export {
  defineRequestScope,
  getRequestScoped,
  getRequestScopeStore,
  setRequestScopeStore,
} from './requestScope';

// --- typed env-validated config ---
export type { ConfigDefinition, ConfigSource } from './config';
export { defineConfig, loadConfigs } from './config';

emitPackageStabilityWarning('@lastshotlabs/slingshot-core', 'experimental');
