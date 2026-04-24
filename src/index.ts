// App factory
export { createApp } from './app';
export type { CreateAppResult, PermissionsConfig } from './app';
export { createServer } from './server';

// SlingshotContext (instance-scoped state)
export type {
  SlingshotContext,
  SlingshotResolvedConfig,
  WsState,
  WsTransportHandle,
  ResolvedPersistence,
} from '@lastshotlabs/slingshot-core';
export type { UploadRegistryRepository, WsMessageRepository } from '@lastshotlabs/slingshot-core';
export type { IdempotencyAdapter } from '@lastshotlabs/slingshot-core';
export {
  getActor,
  getActorId,
  getActorTenantId,
  getRequestTenantId,
} from '@lastshotlabs/slingshot-core';
export { getContext, getContextOrNull } from '@lastshotlabs/slingshot-core';
export { getRedisFromApp } from './lib/redis';
export type { RedisCredentials } from './lib/redis';
export { getMongoFromApp, getMongooseModule } from './lib/mongo';
export type { MongoCredentials } from './lib/mongo';

// Admin — framework convenience wrapper (slingshot-auth-backed defaults)
export { createSlingshotAdminPlugin } from './framework/admin/index.js';
export type { SlingshotAdminPluginConfig } from './framework/admin/index.js';

// Plugin contracts and event bus
export type {
  SlingshotPlugin,
  StandalonePlugin,
  SlingshotEventBus,
  SlingshotEventMap,
  SecurityEventKey,
} from '@lastshotlabs/slingshot-core';
export { createInProcessAdapter, SECURITY_EVENT_TYPES } from '@lastshotlabs/slingshot-core';
export { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
export type {
  AuthPluginConfig,
  AuthDbConfig,
  AuthSecurityConfig,
} from '@lastshotlabs/slingshot-auth';
export type {
  CreateAppConfig,
  ModelSchemasConfig,
  DbConfig,
  SecretsConfig,
  FrameworkSecretsLiteral,
  AppMeta,
  AuthConfig,
  AuthRateLimitConfig,
  AccountDeletionConfig,
  OAuthConfig,
  SecurityConfig,
  CsrfConfig,
  BotProtectionConfig,
  PrimaryField,
  EmailVerificationConfig,
  PasswordResetConfig,
  RefreshTokenConfig,
  MfaConfig,
  MfaEmailOtpConfig,
  MfaWebAuthnConfig,
  JobsConfig,
  TenancyConfig,
  LoggingConfig,
  MetricsConfig,
  ValidationConfig,
  VersioningConfig,
  SigningConfig,
  JwtConfig,
  BreachedPasswordConfig,
  StepUpConfig,
  OidcConfig,
  SamlConfig,
  ScimConfig,
  MagicLinkConfig,
  ObservabilityConfig,
  TracingConfig,
} from './app';
export { createChildSpan } from './app';
export type { CreateServerConfig, WsConfig, SseConfig, SseEndpointConfig } from './server';
export type { SseClientData, SseFilter } from './framework/sse/index.js';
export { createSseUpgradeHandler } from './framework/sse/index.js';

// Core utilities
export { HttpError, ValidationError } from '@lastshotlabs/slingshot-core';
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
} from '@lastshotlabs/slingshot-core';
export { createRouter } from '@lastshotlabs/slingshot-core';
export {
  createRoute,
  withSecurity,
  registerSchema,
  registerSchemas,
} from '@lastshotlabs/slingshot-core';
export { zodToMongoose } from './framework/lib/zodToMongoose.js';
export type { ZodToMongooseConfig, ZodToMongooseRefConfig } from './framework/lib/zodToMongoose.js';
export { createDtoMapper } from './framework/lib/createDtoMapper.js';
export type { DtoMapperConfig } from './framework/lib/createDtoMapper.js';
export type {
  AppEnv,
  AppVariables,
  ValidationErrorFormatter,
  DefaultValidationErrorBody,
  ValidationErrorDetail,
} from '@lastshotlabs/slingshot-core';
export { defaultValidationErrorFormatter } from '@lastshotlabs/slingshot-core';
export { timingSafeEqual, sha256 } from '@lastshotlabs/slingshot-core';
export {
  hmacSign,
  hmacVerify,
  signCookieValue,
  verifyCookieValue,
  signCursor,
  verifyCursor,
  createPresignedUrl,
  verifyPresignedUrl,
} from './lib/signing';
export { log } from './framework/lib/logger.js';
export { validate } from './framework/lib/validate.js';
export { getClientIp } from '@lastshotlabs/slingshot-core';

// Framework middleware
export { idempotent } from './framework/lib/idempotency.js';
export type { IdempotencyOptions } from './framework/lib/idempotency.js';
export { botProtection } from './framework/middleware/botProtection.js';
export type { BotProtectionOptions } from './framework/middleware/botProtection.js';
export { rateLimit } from './framework/middleware/rateLimit.js';
export type { RateLimitOptions } from './framework/middleware/rateLimit.js';
export {
  cacheResponse,
  bustCache,
  bustCachePattern,
} from './framework/middleware/cacheResponse.js';
export { webhookAuth } from './framework/middleware/webhookAuth.js';
export type {
  WebhookAuthOptions,
  WebhookTimestampOptions,
} from './framework/middleware/webhookAuth.js';
export { requireSignedRequest } from './framework/middleware/requestSigning.js';
export type { RequestSigningOptions } from './framework/middleware/requestSigning.js';
export { auditLog } from './framework/middleware/auditLog.js';
export type { AuditLogMiddlewareOptions } from './framework/middleware/auditLog.js';
export { requestId } from './framework/middleware/requestId.js';
export { requestLogger } from './framework/middleware/requestLogger.js';
export type {
  RequestLogEntry,
  RequestLoggerOptions,
  LogLevel,
} from './framework/middleware/requestLogger.js';
export { metricsCollector } from './framework/middleware/metrics.js';
export type { MetricsMiddlewareOptions } from './framework/middleware/metrics.js';
export { requireCaptcha } from './framework/middleware/captcha.js';
export type { CaptchaConfig, CaptchaProvider } from '@lastshotlabs/slingshot-core';

// Audit log
export { createAuditLogProvider } from './framework/auditLog/index.js';
export {
  createMetricsState,
  incrementCounter,
  observeHistogram,
  registerGaugeCallback,
  serializeMetrics,
  closeMetricsQueues,
} from './framework/metrics/registry.js';
export type { AuditLogEntry } from '@lastshotlabs/slingshot-core';
export type { AuditLogOptions, AuditLogQuery } from './framework/auditLog/index.js';

// WebSocket — consumer API
export { createWsUpgradeHandler } from './framework/ws/index.js';
export type { SocketData } from './framework/ws/index.js';
export { publish, getSubscriptions, getRooms, getRoomSubscribers } from './framework/ws/rooms.js';
export type { PublishOptions } from './framework/ws/rooms.js';
export type {
  WsEventContext,
  WsEventHandler,
  WsIncomingEventConfig,
  WsAuthConfig,
  WsMiddlewareHandler,
} from './config/types/ws';

// WebSocket — Transport
export type { WsTransportAdapter } from './framework/ws/transport.js';
export { InMemoryTransport } from './framework/ws/transport.js';
export { createRedisTransport } from './framework/ws/redisTransport.js';
export type { RedisTransportOptions } from './framework/ws/redisTransport.js';

// WebSocket — Heartbeat (config type only)
export type { HeartbeatConfig } from './framework/ws/heartbeat.js';

// WebSocket — Presence (consumer API)
export { getRoomPresence, getUserPresence } from './framework/ws/presence.js';

// Tenancy
export { createTenantService } from './framework/tenancy/service.js';
export type {
  TenantInfo,
  CreateTenantOptions,
  TenantService,
} from './framework/tenancy/service.js';
export { invalidateTenantCache } from './framework/middleware/tenant.js';

// Pagination helpers
export {
  offsetParams,
  parseOffsetParams,
  paginatedResponse,
  cursorParams,
  parseCursorParams,
  cursorResponse,
  maybeSignCursor,
} from './framework/lib/pagination.js';
export type {
  OffsetParamDefaults,
  ParsedOffsetParams,
  CursorParamDefaults,
  ParsedCursorParams,
  CursorResult,
} from './framework/lib/pagination.js';

// Upload — consumer API
export { handleUpload } from './framework/middleware/upload.js';
export type { UploadMiddlewareOptions } from './framework/middleware/upload.js';
export { parseUpload } from './framework/upload/upload.js';
export type { UploadOpts } from './framework/upload/upload.js';
export {
  registerUpload,
  getUploadRecord,
  deleteUploadRecord,
} from './framework/upload/registry.js';
export type { UploadRecord } from '@lastshotlabs/slingshot-core';
export type { StorageAdapter, UploadResult } from '@lastshotlabs/slingshot-core';
export type { UploadConfig, PresignedUrlConfig } from './app';
export { memoryStorage } from './framework/adapters/memoryStorage.js';
export { localStorage } from './framework/adapters/localStorage.js';
export type { LocalStorageConfig } from './framework/adapters/localStorage.js';
export { s3Storage } from './framework/adapters/s3Storage.js';
export type { S3StorageConfig } from './framework/adapters/s3Storage.js';

// Config-driven entity persistence
export { defineEntity, field, index, relation } from '@lastshotlabs/slingshot-core';
export type {
  FieldType,
  FieldDef,
  FieldOptions,
  EntityConfig,
  ResolvedEntityConfig,
  EntityAdapter,
  InferEntity,
  InferCreateInput,
  InferUpdateInput,
  CursorPaginationOptions,
  EntityPaginatedResult,
  IndexDef,
  RelationDef,
  SoftDeleteConfig,
  PaginationConfig,
  TenantConfig,
} from '@lastshotlabs/slingshot-core';
export {
  createEntityFactories,
  createMemoryEntityAdapter,
  createRedisEntityAdapter,
  createSqliteEntityAdapter,
  createMongoEntityAdapter,
  createPostgresEntityAdapter,
  generateSchemas,
  defineOperations,
  op,
  createCompositeFactories,
  toSnakeCase,
  toCamelCase,
  applyDefaults,
  applyOnUpdate,
  encodeCursor,
  decodeCursor,
} from '@lastshotlabs/slingshot-entity';
export type {
  GeneratedSchemas,
  ResolvedOperations,
  OperationConfig,
} from '@lastshotlabs/slingshot-entity';
export {
  defineCapability,
  definePackage,
  domain,
  entityRef,
  inspectPackage,
  provideCapability,
  route,
} from '@lastshotlabs/slingshot-core';
export type {
  DefinePackageInput,
  DomainRouteDefinition,
  PackageCapabilityHandle,
  PackageCapabilityReader,
  PackageDomainRouteContext,
  PackageEntityRef,
  PackageEntityReader,
  PackageInspection,
  PackageRouteRequestContext,
  PublishedPackageCapability,
  SlingshotPackageDefinition,
  TypedRouteContext,
  TypedRouteInput,
  TypedRouteRequestSpec,
  TypedRouteResponseSpec,
  TypedRouteResponses,
} from '@lastshotlabs/slingshot-core';
export { entity } from '@lastshotlabs/slingshot-entity';
export type { EntityModuleWiring, PackageEntityModule } from '@lastshotlabs/slingshot-entity';

// Manifest-driven server bootstrap
export { createServerFromManifest } from './lib/createServerFromManifest';
export type { CreateServerFromManifestOptions } from './lib/createServerFromManifest';
export { createManifestHandlerRegistry } from './lib/manifestHandlerRegistry';
export type {
  ManifestHandlerRegistry,
  HandlerFactory,
  PluginFactory,
  EventBusFactory,
  SecretProviderFactory,
} from './lib/manifestHandlerRegistry';
export { createMcpFoundation } from './lib/mcpFoundation';
export type {
  CreateMcpFoundationOptions,
  McpFoundation,
  McpGenerateConfigOptions,
  McpGenerateConfigResult,
  McpGenerateConfigSuccess,
  McpManifestValidationResult,
  McpPluginSummary,
} from './lib/mcpFoundation';
export { manifestToAppConfig } from './lib/manifestToAppConfig';
export type { ManifestToConfigOptions } from './lib/manifestToAppConfig';
export { manifestToSsgConfig } from './lib/manifestToSsgConfig';
export type { ManifestSsgBuildConfig, ManifestSsgConfigResult } from './lib/manifestToSsgConfig';
export { validateAppManifest } from './lib/manifest';
export type {
  AppManifest,
  AppManifestSsgSection,
  AppManifestSsrSection,
  AppManifestValidationResult,
  AppManifestValidationError,
} from './lib/manifest';
export { PLUGIN_SCHEMA_ENTRIES, loadPluginSchema, listPlugins } from './lib/pluginSchemaRegistry';
export type { PluginSchemaEntry } from './lib/pluginSchemaRegistry';
