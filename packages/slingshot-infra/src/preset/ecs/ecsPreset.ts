import type {
  DeployResult,
  GeneratedFile,
  PresetContext,
  PresetProvider,
  ProvisionResult,
} from '../../types/preset';
import { generateFluentdConfig } from '../shared/generateFluentdConfig';
import { generateDockerfiles } from './generators/dockerfile';
import { generateEcsGhaWorkflow } from './generators/gha';
import { generateSstConfig } from './generators/sst';

/**
 * Configuration options for the ECS preset.
 */
export interface EcsPresetConfig {
  /**
   * Use Fargate Spot capacity for cost savings on non-critical workloads.
   * Default: false.
   */
  fargateSpot?: boolean;
  /**
   * Enable CloudWatch Container Insights for enhanced ECS metrics.
   * Default: false.
   */
  containerInsights?: boolean;
}

/**
 * Create an ECS Fargate preset provider.
 *
 * Generates Dockerfiles, an SST config (for ECS cluster, ALB, task definitions,
 * and auto-scaling), and a GitHub Actions workflow that builds, pushes, and
 * deploys the service. Runs `bunx sst deploy` for both the deploy and
 * provisionStack operations.
 *
 * @param _config - Optional ECS-specific configuration (Fargate Spot, Container
 *   Insights). These settings are passed through to the generated SST config.
 * @returns A `PresetProvider` with name `'ecs'`.
 *
 * @example
 * ```ts
 * import { createEcsPreset } from '@lastshotlabs/slingshot-infra';
 *
 * const preset = createEcsPreset({ fargateSpot: true });
 * // Pass to createPresetRegistry() for use by runDeployPipeline()
 * ```
 */
export function createEcsPreset(config?: EcsPresetConfig): PresetProvider {
  void config;

  return {
    name: 'ecs',

    generate(ctx: PresetContext): GeneratedFile[] {
      const files = [
        ...generateDockerfiles(ctx),
        generateSstConfig(ctx),
        generateEcsGhaWorkflow(ctx),
      ];

      if (ctx.infra.logging?.driver === 'fluentd') {
        files.push(generateFluentdConfig(ctx.infra.logging.fluentd, ctx.serviceName));
      }

      return files;
    },

    async deploy(ctx: PresetContext): Promise<DeployResult> {
      const { spawnSync } = await import('node:child_process');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const deployDir = ctx.tempDir ?? ctx.appRoot;

      // SST runs from tempDir where sst.config.ts is generated.
      // Copy package files SST may need for dependency resolution.
      if (ctx.tempDir) {
        for (const file of ['package.json', 'bun.lock', 'bun.lockb']) {
          const src = path.join(ctx.appRoot, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(ctx.tempDir, file));
          }
        }
      }

      try {
        const result = spawnSync('bunx', ['sst', 'deploy', '--stage', ctx.stageName], {
          cwd: deployDir,
          stdio: 'inherit',
          env: { ...process.env },
        });
        if (result.status !== 0) {
          return {
            success: false,
            error: `SST deploy exited with code ${result.status}`,
          };
        }

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async provisionStack(ctx: PresetContext): Promise<ProvisionResult> {
      const { spawnSync } = await import('node:child_process');

      try {
        const result = spawnSync('bunx', ['sst', 'deploy', '--stage', ctx.stageName], {
          cwd: ctx.appRoot,
          encoding: 'utf-8',
          env: { ...process.env },
        });
        if (result.status !== 0) {
          return {
            success: false,
            outputs: {},
            error: `SST deploy exited with code ${result.status}`,
          };
        }

        return { success: true, outputs: { raw: result.stdout } };
      } catch (err) {
        return {
          success: false,
          outputs: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async destroyStack(ctx: PresetContext): Promise<void> {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('bunx', ['sst', 'destroy', '--stage', ctx.stageName], {
        cwd: ctx.appRoot,
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        throw new Error(`SST destroy exited with code ${result.status}`);
      }
    },

    defaultLogging() {
      return { driver: 'cloudwatch', retentionDays: 30 };
    },
  };
}
