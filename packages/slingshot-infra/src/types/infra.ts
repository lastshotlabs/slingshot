import type { OverrideMap } from './override';
import type { ScalingConfig } from './platform';

/**
 * The frozen, validated output of `defineInfra()`.
 *
 * Describes a single app's deployment configuration: which stacks it targets,
 * what resources it consumes, how its services are declared, and how generated
 * files should be customized.
 *
 * @remarks
 * Always obtained from `defineInfra()` — never constructed directly.
 * The object is `deepFreeze()`d at creation time.
 */
export interface DefineInfraConfig {
  /** Target platform name (from `DefinePlatformConfig.platforms`). Omit for default. */
  platform?: string;
  /** Stacks this app deploys to (for single-service apps) */
  stacks?: string[];
  /** Domain for this app (single-service shorthand) */
  domain?: string;
  /** Size preset: "small", "medium", "large", "xlarge" */
  size?: InfraSize;
  /** Port the app listens on. Default: 3000 */
  port?: number;
  /** Shared resources this app consumes. Auto-wires env vars. */
  uses?: string[];
  /** Health check configuration */
  healthCheck?: string | HealthCheckConfig;
  /** Scaling overrides */
  scaling?: ScalingConfig;
  /** Logging configuration */
  logging?: InfraLoggingConfig;
  /** Overrides for generated files */
  overrides?: OverrideMap;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Service declarations (for multi-service apps) */
  services?: Record<string, ServiceDeclaration>;
  /** Stage-specific domain mappings */
  domains?: Record<string, DomainConfig>;
  /** Network configuration override */
  network?: string | NetworkOverride;
  /** Nginx production directives */
  nginx?: NginxConfig;
  /** App name for cross-repo registry coordination */
  appName?: string;
  /** Explicit repo identity string. Auto-resolved from package.json or git remote if omitted. */
  repo?: string;
  /**
   * Deployment strategy for zero-downtime releases.
   * - "rolling": Replace instances one at a time (default).
   * - "blue-green": Deploy a new set alongside the old, then switch traffic atomically.
   * - "canary": Gradually shift traffic to the new version.
   */
  deployStrategy?: 'rolling' | 'blue-green' | 'canary';
  /**
   * Canary deployment configuration. Only used when deployStrategy is "canary".
   */
  canary?: {
    /** Percentage of traffic to route to the canary deployment (1-99). Default: 10. */
    canaryPercent?: number;
    /** Evaluation period in seconds before auto-promotion. Default: 300. */
    evaluationPeriodSeconds?: number;
    /** Whether to auto-promote after evaluation period. Default: true. */
    autoPromote?: boolean;
  };
}

/**
 * Named size preset for container CPU and memory allocation.
 *
 * Resolved by `SIZE_PRESETS` to ECS-compatible vCPU units and memory in MB.
 */
export type InfraSize = 'small' | 'medium' | 'large' | 'xlarge';

/**
 * Maps `InfraSize` names to ECS Fargate-compatible CPU unit and memory (MB) values.
 *
 * @example
 * ```ts
 * import { SIZE_PRESETS } from '@lastshotlabs/slingshot-infra';
 *
 * const { cpu, memory } = SIZE_PRESETS['medium']; // { cpu: 512, memory: 1024 }
 * ```
 */
export const SIZE_PRESETS: Record<InfraSize, { cpu: number; memory: number }> = {
  small: { cpu: 256, memory: 512 },
  medium: { cpu: 512, memory: 1024 },
  large: { cpu: 1024, memory: 2048 },
  xlarge: { cpu: 2048, memory: 4096 },
};

/**
 * Declaration for a single service within a multi-service app.
 *
 * Each key in `DefineInfraConfig.services` is a logical service name that
 * maps to one microservice/container with its own Dockerfile, domain, port,
 * and resource usage.
 *
 * @example
 * ```ts
 * import type { ServiceDeclaration } from '@lastshotlabs/slingshot-infra';
 *
 * const apiService: ServiceDeclaration = {
 *   path: 'packages/api',
 *   stacks: ['main'],
 *   port: 3000,
 *   size: 'medium',
 *   uses: ['postgres', 'redis'],
 *   healthCheck: '/health',
 *   domains: {
 *     api: { stages: { prod: 'api.example.com', dev: 'api.dev.example.com' } },
 *   },
 * };
 * ```
 */
export interface ServiceDeclaration {
  /** Path to the service entry point (relative to repo root). */
  path: string;
  /** Stacks this service deploys to */
  stacks?: string[];
  /** Domain for this service */
  domain?: string;
  /** Port this service listens on. Default: 3000 */
  port?: number;
  /** Shared resources this service consumes */
  uses?: string[];
  /** Size preset */
  size?: InfraSize;
  /** Scaling overrides */
  scaling?: ScalingConfig;
  /** Health check */
  healthCheck?: string | HealthCheckConfig;
  /** Custom Dockerfile override */
  dockerfile?: string | Record<string, unknown>;
  /** Logging override */
  logging?: InfraLoggingConfig;
  /** Additional env vars */
  env?: Record<string, string>;
  /** Stage-specific domain mappings */
  domains?: Record<string, DomainConfig>;
  /** Nginx production directives */
  nginx?: NginxConfig;
  /** Deployment strategy override for this service. Inherits from top-level deployStrategy if omitted. */
  deployStrategy?: 'rolling' | 'blue-green' | 'canary';
  /**
   * Canary deployment configuration. Only used when deployStrategy is "canary".
   */
  canary?: {
    canaryPercent?: number;
    evaluationPeriodSeconds?: number;
    autoPromote?: boolean;
  };
}

/**
 * Stage-specific domain mapping for a service.
 *
 * When a service should resolve to a different domain per stage, use this
 * instead of the `domain` shorthand in `ServiceDeclaration`.
 *
 * @example
 * ```ts
 * import type { DomainConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const apiDomain: DomainConfig = {
 *   stages: {
 *     dev: 'api.dev.example.com',
 *     prod: 'api.example.com',
 *   },
 *   ssl: true,
 * };
 * ```
 */
export interface DomainConfig {
  /** Map of stage name → fully-qualified domain name. */
  stages: Record<string, string>;
  /** Whether to provision an SSL certificate (Caddy/certbot). Default: `true`. */
  ssl?: boolean;
}

/**
 * HTTP health check configuration for the load balancer or container runtime.
 *
 * @example
 * ```ts
 * import type { HealthCheckConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const hc: HealthCheckConfig = {
 *   path: '/health',
 *   intervalSeconds: 30,
 *   timeoutSeconds: 5,
 *   healthyThreshold: 2,
 *   unhealthyThreshold: 3,
 * };
 * ```
 */
export interface HealthCheckConfig {
  /** HTTP path that returns 2xx when the service is healthy. */
  path: string;
  /** Check interval in seconds. */
  intervalSeconds?: number;
  /** Response timeout in seconds. */
  timeoutSeconds?: number;
  /** Number of consecutive successes before marking healthy. */
  healthyThreshold?: number;
  /** Number of consecutive failures before marking unhealthy. */
  unhealthyThreshold?: number;
}

/**
 * Per-service logging configuration (overrides platform defaults).
 *
 * @example
 * ```ts
 * import type { InfraLoggingConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const logging: InfraLoggingConfig = {
 *   driver: 'cloudwatch',
 *   logGroup: '/my-app/api',
 *   retentionDays: 30,
 * };
 * ```
 */
export interface InfraLoggingConfig {
  /** Log driver override. */
  driver?: 'cloudwatch' | 'local' | 'fluentd';
  /** CloudWatch log group name. */
  logGroup?: string;
  /** Log retention in days (CloudWatch). */
  retentionDays?: number;
  /** Fluentd configuration (when driver is `'fluentd'`). */
  fluentd?: FluentdConfig;
}

/**
 * Fluentd log forwarding configuration.
 *
 * @example
 * ```ts
 * import type { FluentdConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const fluentd: FluentdConfig = {
 *   endpoint: 'localhost:24224',
 *   tagPrefix: 'myapp',
 *   outputs: [{ type: 'elasticsearch', config: { host: 'es.example.com' } }],
 * };
 * ```
 */
export interface FluentdConfig {
  /** Fluentd endpoint. Default: `'localhost:24224'`. */
  endpoint?: string;
  /** Tag prefix for log events. Default: app name. */
  tagPrefix?: string;
  /** Additional output destinations. */
  outputs?: FluentdOutput[];
}

/**
 * A single Fluentd output destination.
 *
 * @example
 * ```ts
 * import type { FluentdOutput } from '@lastshotlabs/slingshot-infra';
 *
 * const out: FluentdOutput = {
 *   type: 's3',
 *   config: { bucket: 'my-logs', region: 'us-east-1' },
 * };
 * ```
 */
export interface FluentdOutput {
  /** Output plugin type. */
  type: 'elasticsearch' | 's3' | 'cloudwatch' | 'stdout';
  /** Plugin-specific configuration key-value pairs. */
  config?: Record<string, string>;
}

/**
 * Per-service network configuration override for EC2 deployments.
 *
 * @example
 * ```ts
 * import type { NetworkOverride } from '@lastshotlabs/slingshot-infra';
 *
 * const net: NetworkOverride = {
 *   mode: 'private',
 *   securityGroups: { app: { inbound: ['80', '443'] } },
 * };
 * ```
 */
export interface NetworkOverride {
  /** Network mode override. */
  mode?: 'public' | 'private';
  /** Security group overrides. */
  securityGroups?: Record<string, unknown>;
  /** Subnet overrides. */
  subnets?: Record<string, unknown>;
}

/**
 * Nginx reverse-proxy configuration for the EC2/nginx preset.
 *
 * All fields are optional and generate sensible defaults in the produced `nginx.conf`.
 *
 * @example
 * ```ts
 * import type { NginxConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const nginx: NginxConfig = {
 *   loadBalancing: 'least-conn',
 *   websocket: true,
 *   gzip: { level: 5, minLength: '2k' },
 *   clientMaxBodySize: '50m',
 *   timeouts: { read: '120s', send: '120s' },
 * };
 * ```
 */
export interface NginxConfig {
  /** Load balancing strategy when multiple instances. Default: 'round-robin' */
  loadBalancing?: 'round-robin' | 'least-conn' | 'ip-hash';

  /** Enable WebSocket support on proxy. Default: false */
  websocket?: boolean;

  /** Gzip compression settings. true for defaults, or configure. Default: true */
  gzip?: boolean | GzipConfig;

  /** Rate limiting. Disabled by default. */
  rateLimit?: NginxRateLimitConfig;

  /** Static file serving path mapping. */
  staticFiles?: NginxStaticConfig;

  /** Max request body size. Default: '10m' */
  clientMaxBodySize?: string;

  /** Proxy timeouts in seconds */
  timeouts?: NginxTimeoutConfig;

  /** Additional custom directives to inject into the http block */
  customDirectives?: string[];
}

/**
 * Nginx gzip compression settings.
 *
 * @example
 * ```ts
 * import type { GzipConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const gzip: GzipConfig = {
 *   minLength: '2k',
 *   level: 5,
 *   types: ['text/html', 'application/json'],
 * };
 * ```
 */
export interface GzipConfig {
  /** Minimum response size to compress. Default: `'1k'` */
  minLength?: string;
  /** MIME types to compress. */
  types?: string[];
  /** Compression level 1–9. Default: 6. */
  level?: number;
}

/**
 * Nginx rate limiting configuration.
 *
 * Applied to the specified paths (or all paths) using the `limit_req` module.
 *
 * @example
 * ```ts
 * import type { NginxRateLimitConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const rateLimit: NginxRateLimitConfig = {
 *   requestsPerSecond: 5,
 *   burst: 10,
 *   zone: 'api_limit',
 *   paths: ['/api/'],
 * };
 * ```
 */
export interface NginxRateLimitConfig {
  /** Requests per second per client IP. Default: 10. */
  requestsPerSecond?: number;
  /** Burst size above the per-second limit before returning 429. Default: 20. */
  burst?: number;
  /** Shared memory zone name. Default: `'api_limit'`. */
  zone?: string;
  /** URL paths to apply rate limiting to. Default: all paths. */
  paths?: string[];
}

/**
 * Nginx static file serving configuration.
 *
 * Requests matching `urlPath` are served directly from `fsPath` on the
 * container filesystem instead of being proxied to the app.
 *
 * @example
 * ```ts
 * import type { NginxStaticConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const staticFiles: NginxStaticConfig = {
 *   urlPath: '/assets/',
 *   fsPath: '/app/public/assets',
 *   cacheControl: '30d',
 * };
 * ```
 */
export interface NginxStaticConfig {
  /** URL path prefix for static files (e.g. `'/static/'`). */
  urlPath: string;
  /** Filesystem path on the container (e.g. `'/app/public'`). */
  fsPath: string;
  /** `Cache-Control: max-age` directive (e.g. `'30d'`, `'1h'`). */
  cacheControl?: string;
}

/**
 * Nginx proxy timeout configuration.
 *
 * @example
 * ```ts
 * import type { NginxTimeoutConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const timeouts: NginxTimeoutConfig = {
 *   connect: '10s',
 *   read: '120s',
 *   send: '120s',
 *   keepalive: '75s',
 * };
 * ```
 */
export interface NginxTimeoutConfig {
  /** Proxy connect timeout. Default: `'60s'`. */
  connect?: string;
  /** Proxy read timeout. Default: `'60s'`. */
  read?: string;
  /** Proxy send timeout. Default: `'60s'`. */
  send?: string;
  /** Keepalive timeout. Default: `'65s'`. */
  keepalive?: string;
}
