import { z } from 'zod';
import type { DefineInfraConfig } from '../types/infra';
import { deepFreeze } from './deepFreeze';
import { scalingSchema } from './sharedSchemas';

const healthCheckSchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    intervalSeconds: z.number().positive().optional(),
    timeoutSeconds: z.number().positive().optional(),
    healthyThreshold: z.number().int().positive().optional(),
    unhealthyThreshold: z.number().int().positive().optional(),
  }),
]);

const fluentdOutputSchema = z.object({
  type: z.enum(['elasticsearch', 's3', 'cloudwatch', 'stdout']),
  config: z.record(z.string(), z.string()).optional(),
});

const fluentdConfigSchema = z.object({
  endpoint: z.string().optional(),
  tagPrefix: z.string().optional(),
  outputs: z.array(fluentdOutputSchema).optional(),
});

const loggingSchema = z.object({
  driver: z.enum(['cloudwatch', 'local', 'fluentd']).optional(),
  logGroup: z.string().optional(),
  retentionDays: z.number().positive().optional(),
  fluentd: fluentdConfigSchema.optional(),
});

const overrideSpecSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const overrideMapSchema = z.object({
  dockerfile: overrideSpecSchema.optional(),
  dockerCompose: overrideSpecSchema.optional(),
  gha: overrideSpecSchema.optional(),
  sst: overrideSpecSchema.optional(),
  caddy: overrideSpecSchema.optional(),
  nginx: overrideSpecSchema.optional(),
});

const domainConfigSchema = z.object({
  stages: z.record(z.string(), z.string()),
  ssl: z.boolean().optional(),
});

const networkOverrideSchema = z.union([
  z.string(),
  z.object({
    mode: z.enum(['public', 'private']).optional(),
    securityGroups: z.record(z.string(), z.unknown()).optional(),
    subnets: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const gzipConfigSchema = z.object({
  minLength: z.string().optional(),
  types: z.array(z.string()).optional(),
  level: z.number().int().min(1).max(9).optional(),
});

const rateLimitSchema = z.object({
  requestsPerSecond: z.number().positive().optional(),
  burst: z.number().int().positive().optional(),
  zone: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

const staticFilesSchema = z.object({
  urlPath: z.string().min(1),
  fsPath: z.string().min(1),
  cacheControl: z.string().optional(),
});

const timeoutSchema = z.object({
  connect: z.string().optional(),
  read: z.string().optional(),
  send: z.string().optional(),
  keepalive: z.string().optional(),
});

const nginxConfigSchema = z.object({
  loadBalancing: z.enum(['round-robin', 'least-conn', 'ip-hash']).optional(),
  websocket: z.boolean().optional(),
  gzip: z.union([z.boolean(), gzipConfigSchema]).optional(),
  rateLimit: rateLimitSchema.optional(),
  staticFiles: staticFilesSchema.optional(),
  clientMaxBodySize: z.string().optional(),
  timeouts: timeoutSchema.optional(),
  customDirectives: z.array(z.string()).optional(),
});

const serviceDeclarationSchema = z.object({
  path: z.string().min(1),
  stacks: z.array(z.string()).optional(),
  domain: z.string().optional(),
  port: z.number().int().positive().optional(),
  uses: z.array(z.string()).optional(),
  size: z.enum(['small', 'medium', 'large', 'xlarge']).optional(),
  scaling: scalingSchema.optional(),
  healthCheck: healthCheckSchema.optional(),
  dockerfile: overrideSpecSchema.optional(),
  logging: loggingSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  domains: z.record(z.string(), domainConfigSchema).optional(),
  nginx: nginxConfigSchema.optional(),
});

const infraConfigSchema = z
  .object({
    platform: z.string().optional(),
    stacks: z.array(z.string()).optional(),
    domain: z.string().optional(),
    size: z.enum(['small', 'medium', 'large', 'xlarge']).optional(),
    port: z.number().int().positive().optional(),
    uses: z.array(z.string()).optional(),
    healthCheck: healthCheckSchema.optional(),
    scaling: scalingSchema.optional(),
    logging: loggingSchema.optional(),
    overrides: overrideMapSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    services: z.record(z.string(), serviceDeclarationSchema).optional(),
    domains: z.record(z.string(), domainConfigSchema).optional(),
    network: networkOverrideSchema.optional(),
    nginx: nginxConfigSchema.optional(),
  })
  .refine(
    data => {
      if (data.services && data.stacks) return true;
      if (!data.services && !data.stacks) return false;
      return true;
    },
    {
      message:
        'Single-service apps must specify "stacks". Multi-service apps specify stacks per service.',
    },
  );

/**
 * Define and validate the infrastructure configuration for a single Slingshot app.
 *
 * Validates `config` against the Zod schema and returns a frozen, immutable
 * copy. Typically placed in a `slingshot.infra.ts` file at the app root.
 *
 * @param config - App-level infrastructure configuration.
 * @returns A frozen `DefineInfraConfig` object.
 *
 * @throws {Error} If any required field is missing or invalid. For example:
 *   a single-service app must provide `stacks`; a multi-service app declares
 *   stacks per service.
 *
 * @example
 * ```ts
 * // slingshot.infra.ts
 * import { defineInfra } from '@lastshotlabs/slingshot-infra';
 *
 * export default defineInfra({
 *   stacks: ['main'],
 *   size: 'small',
 *   port: 3000,
 *   uses: ['postgres', 'redis'],
 *   healthCheck: '/health',
 * });
 * ```
 */
export function defineInfra(config: DefineInfraConfig): Readonly<DefineInfraConfig> {
  const result = infraConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[slingshot-infra] Invalid infra config:\n${issues}`);
  }
  return deepFreeze(result.data as DefineInfraConfig);
}
