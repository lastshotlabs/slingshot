/**
 * Generate a complete `slingshot.platform.ts` scaffold with sensible defaults.
 *
 * Produces a ready-to-edit TypeScript source string that can be written to
 * disk by the `slingshot platform init` CLI command.
 *
 * @param opts.org - Organisation identifier used in resource naming. Default: `'myorg'`.
 * @param opts.region - Default AWS region. Default: `'us-east-1'`.
 * @param opts.preset - Default stack preset (`'ecs'`, `'ec2-nginx'`, etc.). Default: `'ecs'`.
 * @param opts.stages - Deployment stage names. Default: `['dev', 'prod']`.
 * @param opts.resources - Shared resource type names to pre-populate. Default: `[]`.
 * @returns The full TypeScript source string of the generated `slingshot.platform.ts`.
 *
 * @example
 * ```ts
 * import { generatePlatformTemplate } from '@lastshotlabs/slingshot-infra';
 * import { writeFileSync } from 'node:fs';
 *
 * writeFileSync('slingshot.platform.ts', generatePlatformTemplate({
 *   org: 'acme',
 *   stages: ['dev', 'staging', 'prod'],
 *   resources: ['postgres', 'redis'],
 * }));
 * ```
 */
export function generatePlatformTemplate(opts?: {
  org?: string;
  region?: string;
  preset?: string;
  stages?: string[];
  resources?: string[];
}): string {
  const org = opts?.org ?? 'myorg';
  const region = opts?.region ?? 'us-east-1';
  const preset = opts?.preset ?? 'ecs';
  const stages = opts?.stages ?? ['dev', 'prod'];
  const resources = opts?.resources ?? [];

  const stagesBlock = stages
    .map(stage => {
      if (stage === 'dev') {
        return `    ${stage}: {\n      domainSuffix: '.dev.${org}.com',\n      env: { NODE_ENV: 'development' },\n    },`;
      }
      if (stage === 'prod') {
        return `    ${stage}: {\n      env: { NODE_ENV: 'production' },\n      stacks: {\n        'main': {\n          scaling: { min: 2, max: 10, targetCpuPercent: 70 },\n        },\n      },\n    },`;
      }
      return `    ${stage}: {\n      env: { NODE_ENV: '${stage}' },\n    },`;
    })
    .join('\n');
  const resourcesBlock = resources.length
    ? `  resources: {\n${resources
        .map(
          resource =>
            `    ${resource}: {\n      type: '${resource}',\n      provision: false,\n    },`,
        )
        .join('\n')}\n  },`
    : `  // resources: {
  //   postgres: { type: 'postgres', provision: false },
  // }`;

  return `import { definePlatform } from '@lastshotlabs/slingshot-infra';

/**
 * Platform configuration — defines your cloud infrastructure layout.
 *
 * This file is typically placed at the repository root and shared across
 * all apps in the monorepo. It declares the organization, cloud provider,
 * registry, stages, and stack presets.
 */
export default definePlatform({
  // --- Organization identifier (used in resource naming) ---
  org: '${org}',

  // --- Cloud provider. Only "aws" is supported in v1. ---
  provider: 'aws',

  // --- Default AWS region for all resources ---
  region: '${region}',

  // --- Registry: where platform state and artifacts are stored ---
  // Use 'local' for development, switch to 's3' for production.
  registry: {
    provider: 'local',
    path: '.slingshot/registry.json',
  },

  // --- Deployment stages ---
  // Each stage represents an isolated environment (dev, staging, prod, etc.).
  stages: {
${stagesBlock}
  },

  // --- Shared resources ---
  // Use the TUI selection above to seed resource stubs for this platform.
${resourcesBlock}

  // --- Stacks: groups of services on shared infrastructure ---
  // Each stack uses a preset that determines how services are deployed.
  stacks: {
    'main': { preset: '${preset}' },
    // 'dev-box': { preset: 'ec2-nginx' },
  },

  // --- Org-wide defaults applied to all apps unless overridden ---
  defaults: {
    preset: '${preset}',
    scaling: { min: 1, max: 3, cpu: 256, memory: 512 },
    logging: { driver: 'cloudwatch', retentionDays: 30 },
  },
});
`;
}
