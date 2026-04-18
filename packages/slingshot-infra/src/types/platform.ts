/**
 * DNS provider configuration for automatic domain record management.
 *
 * Attached to `DefinePlatformConfig.dns`. The deploy pipeline calls
 * `createDnsManager(config)` after a successful deploy.
 */
export interface DnsProviderConfig {
  /** DNS provider backend. `'manual'` logs instructions without API calls. */
  provider: 'cloudflare' | 'route53' | 'manual';
  /** Cloudflare API token (from env or secrets) */
  apiToken?: string;
  /** Cloudflare zone ID (or auto-resolve from domain) */
  zoneId?: string;
  /** Whether to proxy through Cloudflare (orange cloud). Default: true */
  proxied?: boolean;
}

/**
 * The frozen, validated output of `definePlatform()`.
 *
 * Describes the entire deployment platform: cloud provider, registry backend,
 * shared resources, named stacks, deployment stages, and org-wide defaults.
 * Passed to deploy pipeline functions as the top-level config object.
 *
 * @remarks
 * Always obtained from `definePlatform()` — never constructed directly.
 * The object is `deepFreeze()`d at creation time.
 */
export interface DefinePlatformConfig {
  /** Organization name (used as SST app name prefix and in resource naming). */
  org: string;
  /** Cloud provider. Only `'aws'` is supported in v1. */
  provider: 'aws';
  /** Default AWS region for all resources. */
  region: string;
  /** Registry backend for persisting deploy state. */
  registry: RegistryConfig;
  /** Secret provider for platform-level secrets. */
  secrets?: PlatformSecretsConfig;
  /** Shared infrastructure resources provisioned once and consumed by many apps. */
  resources?: Record<string, SharedResourceConfig>;
  /** Named stacks — groups of services running on shared infrastructure. */
  stacks?: Record<string, StackConfig>;
  /** Deployment stages (e.g. `'development'`, `'staging'`, `'production'`). */
  stages: Record<string, StageConfig>;
  /** Org-wide defaults applied to all apps unless overridden. */
  defaults?: PlatformDefaults;
  /** Named platform sub-configs for multi-tenant / multi-client isolation. */
  platforms?: Record<string, PlatformEntry>;
  /** DNS provider for automatic domain record management after deploy. */
  dns?: DnsProviderConfig;
}

/**
 * A named platform sub-config used for multi-tenant or multi-client isolation.
 *
 * Consumer apps can target a specific platform entry via `defineInfra({ platform: 'name' })`,
 * causing the deploy pipeline to use that entry's stages/stacks/resources instead of the
 * top-level config.
 */
export interface PlatformEntry {
  provider: 'aws';
  region: string;
  registry: RegistryConfig;
  secrets?: PlatformSecretsConfig;
  resources?: Record<string, SharedResourceConfig>;
  stacks?: Record<string, StackConfig>;
  stages: Record<string, StageConfig>;
  defaults?: PlatformDefaults;
}

/**
 * Registry backend configuration.
 *
 * Discriminated by `provider`. Used by `createRegistryFromConfig()` to
 * instantiate the correct `RegistryProvider`.
 */
export interface RegistryConfig {
  /** Registry provider type. */
  provider: 's3' | 'local' | 'redis' | 'postgres';
  /** S3 bucket name (s3 provider). */
  bucket?: string;
  /** S3 key prefix. Default: `'slingshot-registry/'` */
  prefix?: string;
  /** AWS region for the S3 bucket. */
  region?: string;
  /** Local file path (local provider). */
  path?: string;
  /** Redis URL, e.g. `'redis://localhost:6379'` (redis provider). */
  url?: string;
  /** Redis key to store the registry document. Default: `'slingshot:registry'` (redis provider). */
  key?: string;
  /** Postgres connection string (postgres provider). */
  connectionString?: string;
  /** Postgres table name. Default: `'slingshot_registry'` (postgres provider). */
  table?: string;
}

/**
 * Secrets provider configuration for SSM Parameter Store, env vars, or file-based secrets.
 */
export interface PlatformSecretsConfig {
  /** Backend for secret storage and retrieval. */
  provider: 'env' | 'ssm' | 'file';
  /** SSM path prefix, e.g. `'/myorg/'` (ssm provider). */
  pathPrefix?: string;
  /** AWS region for SSM (ssm provider). */
  region?: string;
  /** Directory for file-based secrets (file provider). */
  directory?: string;
}

/**
 * Shared infrastructure resource definition.
 *
 * When `provision: true`, slingshot provisions the resource via SST/Pulumi.
 * When `provision: false`, the `connection` map is used as-is.
 */
export interface SharedResourceConfig {
  /** Resource type determines which provisioner factory is used. */
  type: 'postgres' | 'redis' | 'kafka' | 'mongo' | 'documentdb';
  /** When `true`, slingshot provisions the resource (RDS, ElastiCache, MSK, etc.). */
  provision: boolean;
  /** Connection settings used when `provision: false`. */
  connection?: Record<string, string>;
  /** Per-stage overrides for instance sizing and connection strings. */
  stages?: Record<string, ResourceStageOverride>;
}

/**
 * Per-stage overrides for a shared resource.
 */
export interface ResourceStageOverride {
  /** e.g. `'db.t3.micro'` for RDS, `'cache.t3.micro'` for ElastiCache. */
  instanceClass?: string;
  /** Storage in GB (Kafka EBS, RDS allocated storage). */
  storageGb?: number;
  /** Connection string override for this stage (overrides provisioned outputs). */
  connection?: Record<string, string>;
}

/**
 * Named stack configuration — a group of services sharing infrastructure.
 *
 * Each stack entry maps to a preset (e.g. `'ecs'` or `'ec2-nginx'`) that
 * handles file generation and deployment.
 */
export interface StackConfig {
  /** Which preset this stack uses. */
  preset: 'ecs' | 'ec2-nginx' | (string & {});
  /** Preset-specific configuration passed to the preset factory. */
  config?: Record<string, unknown>;
  /** Network configuration for this stack's VPC/subnets. */
  network?: NetworkConfig;
}

/**
 * Deployment stage configuration (e.g. `'development'`, `'staging'`, `'production'`).
 */
export interface StageConfig {
  /** Human-readable label for the stage. */
  name?: string;
  /** Domain suffix appended to service domains for this stage, e.g. `'.staging.myapp.com'`. */
  domainSuffix?: string;
  /** Default resource sizing for provisioners in this stage. */
  resourceDefaults?: {
    instanceClass?: string;
    storageGb?: number;
  };
  /** Environment variables injected into all services in this stage. */
  env?: Record<string, string>;
  /** Per-stack scaling and network overrides for this stage. */
  stacks?: Record<string, StackStageOverride>;
}

/**
 * Per-stage overrides for a specific stack (scaling, network).
 */
export interface StackStageOverride {
  /** Scaling overrides for this stack in this stage. */
  scaling?: ScalingConfig;
  /** Partial network config overrides. */
  network?: Partial<NetworkConfig>;
}

/**
 * VPC and network configuration for a stack.
 */
export interface NetworkConfig {
  /** VPC CIDR block. Default: `'10.0.0.0/16'` */
  vpcCidr?: string;
  /** Number of availability zones. Default: 2 */
  azCount?: number;
  /** Whether to create NAT gateway(s). Default: `true` for prod. */
  natGateway?: boolean;
  /** `'public'`: containers in public subnet, no NAT. `'private'`: private subnets with NAT. */
  mode?: 'public' | 'private';
  /** SSH key pair name (ec2-nginx only). */
  sshKeyName?: string;
}

/**
 * Container/instance scaling configuration.
 */
export interface ScalingConfig {
  /** Minimum instances/containers. Default: 1. */
  min?: number;
  /** Maximum instances/containers. Default: 2. */
  max?: number;
  /** CPU — vCPU units for ECS (256, 512, 1024, etc.) or instance type for EC2 (e.g. `'t3.medium'`). */
  cpu?: number | string;
  /** Memory in MB (ECS only). */
  memory?: number;
  /** Target CPU utilization % for ECS autoscaling. ECS only. */
  targetCpuPercent?: number;
}

/**
 * Org-wide defaults applied to all stacks and services unless overridden.
 */
export interface PlatformDefaults {
  /** Default preset for new stacks. */
  preset?: 'ecs' | 'ec2-nginx' | (string & {});
  /** Default container/instance scaling. */
  scaling?: ScalingConfig;
  /** Default logging driver and retention. */
  logging?: LoggingDefaults;
  /** Docker registry URL for pushing/pulling images. Defaults to ECR. */
  dockerRegistry?: string;
}

/**
 * Default logging driver and log retention settings.
 */
export interface LoggingDefaults {
  /** Log driver for container output. */
  driver: 'cloudwatch' | 'local' | 'fluentd';
  /** Log retention in days (CloudWatch). */
  retentionDays?: number;
}
