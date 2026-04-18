import { z } from 'zod';
import type { DefinePlatformConfig } from '../types/platform';
import { deepFreeze } from './deepFreeze';
import { scalingSchema } from './sharedSchemas';

const registryConfigSchema = z
  .object({
    provider: z.enum(['s3', 'local', 'redis', 'postgres']),
    bucket: z.string().min(3).optional(),
    prefix: z.string().optional(),
    region: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    key: z.string().optional(),
    connectionString: z.string().optional(),
    table: z.string().optional(),
  })
  .refine(
    data => {
      if (data.provider === 's3' && !data.bucket) return false;
      if (data.provider === 'local' && !data.path) return false;
      if (data.provider === 'redis' && !data.url) return false;
      if (data.provider === 'postgres' && !data.connectionString) return false;
      return true;
    },
    {
      message:
        's3 provider requires "bucket", local provider requires "path", ' +
        'redis provider requires "url", postgres provider requires "connectionString"',
    },
  );

const platformSecretsSchema = z.object({
  provider: z.enum(['env', 'ssm', 'file']),
  pathPrefix: z.string().optional(),
  region: z.string().optional(),
  directory: z.string().optional(),
});

const resourceStageOverrideSchema = z.object({
  instanceClass: z.string().optional(),
  storageGb: z.number().positive().optional(),
  connection: z.record(z.string(), z.string()).optional(),
});

const sharedResourceSchema = z.object({
  type: z.enum(['postgres', 'redis', 'kafka', 'mongo', 'documentdb']),
  provision: z.boolean(),
  connection: z.record(z.string(), z.string()).optional(),
  stages: z.record(z.string(), resourceStageOverrideSchema).optional(),
});

const networkSchema = z.object({
  vpcCidr: z.string().optional(),
  azCount: z.number().int().min(1).max(6).optional(),
  natGateway: z.boolean().optional(),
  mode: z.enum(['public', 'private']).optional(),
  sshKeyName: z.string().optional(),
});

const stackSchema = z.object({
  preset: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  network: networkSchema.optional(),
});

const stackStageOverrideSchema = z.object({
  scaling: scalingSchema.optional(),
  network: networkSchema.partial().optional(),
});

const stageSchema = z.object({
  name: z.string().optional(),
  domainSuffix: z.string().optional(),
  resourceDefaults: z
    .object({
      instanceClass: z.string().optional(),
      storageGb: z.number().positive().optional(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  stacks: z.record(z.string(), stackStageOverrideSchema).optional(),
});

const loggingDefaultsSchema = z.object({
  driver: z.enum(['cloudwatch', 'local', 'fluentd']),
  retentionDays: z.number().positive().optional(),
});

const dnsProviderConfigSchema = z
  .object({
    provider: z.enum(['cloudflare', 'route53', 'manual']),
    apiToken: z.string().optional(),
    zoneId: z.string().optional(),
    proxied: z.boolean().optional(),
  })
  .refine(
    data => {
      if (data.provider === 'cloudflare' && !data.apiToken) return false;
      return true;
    },
    { message: 'Cloudflare provider requires "apiToken"' },
  );

const platformDefaultsSchema = z.object({
  preset: z.string().optional(),
  scaling: scalingSchema.optional(),
  logging: loggingDefaultsSchema.optional(),
  dockerRegistry: z.string().optional(),
});

const platformEntrySchema = z.object({
  provider: z.literal('aws'),
  region: z.string().min(1),
  registry: registryConfigSchema,
  secrets: platformSecretsSchema.optional(),
  resources: z.record(z.string(), sharedResourceSchema).optional(),
  stacks: z.record(z.string(), stackSchema).optional(),
  stages: z.record(z.string(), stageSchema),
  defaults: platformDefaultsSchema.optional(),
});

const platformConfigSchema = z.object({
  org: z.string().min(1),
  provider: z.literal('aws'),
  region: z.string().min(1),
  registry: registryConfigSchema,
  secrets: platformSecretsSchema.optional(),
  resources: z.record(z.string(), sharedResourceSchema).optional(),
  stacks: z.record(z.string(), stackSchema).optional(),
  stages: z.record(z.string(), stageSchema),
  defaults: platformDefaultsSchema.optional(),
  platforms: z.record(z.string(), platformEntrySchema).optional(),
  dns: dnsProviderConfigSchema.optional(),
});

/**
 * Define and validate the platform configuration for a Slingshot organisation.
 *
 * Validates `config` against the full Zod schema (registry provider
 * requirements, stage declarations, DNS provider checks) and returns a
 * frozen, immutable copy.
 *
 * Typically placed in a `slingshot.platform.ts` file at the repository root,
 * shared by all apps in the monorepo.
 *
 * @param config - Platform configuration to validate.
 * @returns A frozen `DefinePlatformConfig` object.
 *
 * @throws {Error} If any required field is missing, invalid, or violates a
 *   cross-field refinement (e.g. S3 registry without a bucket).
 *
 * @example
 * ```ts
 * // slingshot.platform.ts
 * import { definePlatform } from '@lastshotlabs/slingshot-infra';
 *
 * export default definePlatform({
 *   org: 'acme',
 *   provider: 'aws',
 *   region: 'us-east-1',
 *   registry: { provider: 'local', path: '.slingshot/registry.json' },
 *   stages: {
 *     dev:  { env: { NODE_ENV: 'development' } },
 *     prod: { env: { NODE_ENV: 'production' } },
 *   },
 *   stacks: { main: { preset: 'ecs' } },
 * });
 * ```
 */
export function definePlatform(config: DefinePlatformConfig): Readonly<DefinePlatformConfig> {
  const result = platformConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[slingshot-infra] Invalid platform config:\n${issues}`);
  }
  return deepFreeze(result.data as DefinePlatformConfig);
}
