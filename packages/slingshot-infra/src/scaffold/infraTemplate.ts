/**
 * Generate a complete `slingshot.infra.ts` scaffold with sensible defaults.
 *
 * Produces a ready-to-edit TypeScript source string that can be written to
 * disk by the `slingshot infra init` CLI command.
 *
 * @param opts.stacks - Stack names this app deploys to. Default: `['main']`.
 * @param opts.port - Port the app listens on. Default: `3000`.
 * @returns The full TypeScript source string of the generated `slingshot.infra.ts`.
 *
 * @example
 * ```ts
 * import { generateInfraTemplate } from '@lastshotlabs/slingshot-infra';
 * import { writeFileSync } from 'node:fs';
 *
 * writeFileSync('slingshot.infra.ts', generateInfraTemplate({ port: 8080 }));
 * ```
 */
export function generateInfraTemplate(opts?: { stacks?: string[]; port?: number }): string {
  const stacks = opts?.stacks ?? ['main'];
  const port = opts?.port ?? 3000;

  const stacksLiteral = stacks.map(s => `'${s}'`).join(', ');

  return `import { defineInfra } from '@lastshotlabs/slingshot-infra';

/**
 * Infra configuration — declares how this app is deployed.
 *
 * This file lives at the app root and tells slingshot which stacks to
 * deploy to, what size container to use, and which shared resources
 * the app consumes.
 */
export default defineInfra({
  // --- Stacks this app deploys to ---
  // Must match stack names defined in slingshot.platform.ts.
  stacks: [${stacksLiteral}],

  // --- Container size preset ---
  // Options: 'small' (256 CPU / 512 MB), 'medium', 'large', 'xlarge'
  size: 'small',

  // --- Port the app listens on ---
  port: ${port},

  // --- Shared resources this app consumes ---
  // Reference resources defined in the platform config. Slingshot auto-wires
  // connection strings as environment variables.
  // Available resource types: 'postgres', 'redis', 'kafka', 'mongo'
  uses: [],

  // --- Health check endpoint ---
  // ALB/target-group will poll this path to verify the app is healthy.
  healthCheck: '/health',

  // --- Additional environment variables ---
  // env: {
  //   LOG_LEVEL: 'info',
  // },

  // --- Scaling overrides (optional, inherits from platform defaults) ---
  // scaling: {
  //   min: 1,
  //   max: 5,
  //   targetCpuPercent: 70,
  // },
});
`;
}
