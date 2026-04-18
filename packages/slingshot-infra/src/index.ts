// Config factories
export { definePlatform } from './config/platformSchema';
export { defineInfra } from './config/infraSchema';
export { resolvePlatformConfig } from './config/resolvePlatformConfig';

// App config analysis
export { deriveUsesFromAppConfig, compareInfraResources } from './config/deriveUsesFromApp';
export type { InfraCheckDiagnostics } from './config/deriveUsesFromApp';

// WebSocket scaling diagnostics
export { auditWebsocketScaling } from './config/websocketScalingAudit';
export type {
  WsDiagnostic,
  WsDiagnosticSeverity,
  WsScalingAuditResult,
} from './config/websocketScalingAudit';

// Scaffold templates
export { generatePlatformTemplate } from './scaffold/platformTemplate';
export { generateInfraTemplate } from './scaffold/infraTemplate';

// Config loaders
export { loadPlatformConfig } from './loader/loadPlatformConfig';
export { loadInfraConfig } from './loader/loadInfraConfig';

// Registry factories
export { createS3Registry } from './registry/s3Registry';
export type { S3RegistryConfig } from './registry/s3Registry';
export { createLocalRegistry } from './registry/localRegistry';
export type { LocalRegistryConfig } from './registry/localRegistry';
export { createRegistryFromConfig } from './registry/createRegistryFromConfig';
export { parseRegistryUrl } from './registry/parseRegistryUrl';

// App registry (cross-repo coordination)
export {
  registerApp,
  listApps,
  getAppsByStack,
  getAppsByResource,
  deregisterApp,
} from './registry/appRegistry';

// Preset factories
export { createEcsPreset } from './preset/ecs/ecsPreset';
export type { EcsPresetConfig } from './preset/ecs/ecsPreset';
export { createEc2NginxPreset } from './preset/ec2-nginx/ec2NginxPreset';
export type { Ec2NginxPresetConfig } from './preset/ec2-nginx/ec2NginxPreset';
export { createPresetRegistry } from './preset/presetRegistry';

// Resource provisioners
export { createProvisionerRegistry } from './resource/provisionerRegistry';
export { createPostgresProvisioner } from './resource/provisioners/postgres';
export { createRedisProvisioner } from './resource/provisioners/redis';
export { createKafkaProvisioner } from './resource/provisioners/kafka';
export { createMongoProvisioner } from './resource/provisioners/mongo';
export { createDocumentDbProvisioner } from './resource/provisioners/documentdb';

// Resource destroy pipeline
export { destroyResources } from './resource/destroyResources';
export type { DestroyResourcesParams, DestroyResourceResult } from './resource/destroyResources';

// SST resource provisioning
export { provisionViaSst, destroyViaSst } from './resource/provisionViaSst';
export type {
  SSTProvisionOptions,
  SSTProvisionResult,
  SSTDestroyOptions,
  ProcessRunner,
} from './resource/provisionViaSst';
export { generateResourceSstConfig } from './resource/generateResourceSst';
export type {
  ResourceProvisionEntry,
  GenerateResourceSstOptions,
} from './resource/generateResourceSst';

// DNS
export { createCloudflareClient } from './dns/cloudflare';
export type { DnsClient, DnsRecord } from './dns/cloudflare';
export { createDnsManager } from './dns/manager';
export type { DnsManager } from './dns/manager';

// Deploy pipeline
export { runDeployPipeline } from './deploy/pipeline';
export type { DeployPipelineOptions, DeployPipelineResult } from './deploy/pipeline';
export { resolveEnvironment } from './deploy/resolveEnv';
export { computeDeployPlan } from './deploy/plan';
export type { DeployPlan, DeployPlanEntry } from './deploy/plan';
export { formatDeployPlan } from './deploy/formatPlan';

// Rollback
export { runRollback } from './deploy/rollback';
export type { RollbackOptions, RollbackResult } from './deploy/rollback';

// Secrets
export { createSecretsManager } from './secrets/secretsManager';
export type { SecretsManager, SecretsCheckResult } from './secrets/secretsManager';
export { resolveRequiredKeys } from './secrets/resolveRequiredKeys';

// Override resolution
export { resolveOverride, deepMerge } from './override/resolveOverrides';

// Types
export type {
  DefinePlatformConfig,
  PlatformEntry,
  RegistryConfig,
  PlatformSecretsConfig,
  SharedResourceConfig,
  ResourceStageOverride,
  StackConfig,
  StageConfig,
  StackStageOverride,
  NetworkConfig,
  ScalingConfig,
  PlatformDefaults,
  LoggingDefaults,
  DnsProviderConfig,
} from './types/platform';
export type {
  DefineInfraConfig,
  ServiceDeclaration,
  DomainConfig,
  HealthCheckConfig,
  InfraLoggingConfig,
  InfraSize,
  NetworkOverride,
  NginxConfig,
  GzipConfig,
  NginxRateLimitConfig,
  NginxStaticConfig,
  NginxTimeoutConfig,
} from './types/infra';
export { SIZE_PRESETS } from './types/infra';
export type {
  RegistryDocument,
  RegistryStackEntry,
  RegistryResourceEntry,
  RegistryServiceEntry,
  RegistryAppEntry,
  RegistryProvider,
  RegistryLock,
} from './types/registry';
export type {
  PresetContext,
  GeneratedFile,
  PresetProvider,
  DeployResult,
  ProvisionResult,
} from './types/preset';
export { getServiceEnv } from './types/preset';
export type {
  ResourceProvisioner,
  ResourceProvisionerContext,
  ResourceOutput,
} from './types/resource';
export { RESOURCE_ENV_KEYS } from './types/resource';
export type { OverrideSpec, OverrideMap } from './types/override';
export { createEmptyRegistryDocument } from './types/registry';
