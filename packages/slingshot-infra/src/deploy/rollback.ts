import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvePlatformConfig } from '../config/resolvePlatformConfig';
import { resolveOverride } from '../override/resolveOverrides';
import type { DefineInfraConfig } from '../types/infra';
import type { DefinePlatformConfig } from '../types/platform';
import type { PresetContext, PresetProvider } from '../types/preset';
import type { RegistryProvider } from '../types/registry';
import { extractServiceNameFromDockerfile, mapFileToOverrideKey } from './overrideMapping';
import { updateRegistryService } from './pipeline';
import { resolveEnvironment } from './resolveEnv';

/**
 * Options for `runRollback()`.
 */
export interface RollbackOptions {
  /** Frozen platform config from `definePlatform()`. */
  platform: DefinePlatformConfig;
  /** Frozen infra config from `defineInfra()`. */
  infra: DefineInfraConfig;
  /** Deployment stage to roll back (e.g. `'production'`). */
  stageName: string;
  /** Registry provider for reading/writing deploy state. */
  registry: RegistryProvider;
  /** Preset registry providing preset instances by name. */
  presetRegistry: { get(name: string): PresetProvider };
  /** Absolute path to the app root directory. */
  appRoot: string;
  /** Rollback only this service. When omitted, all services with stage data are rolled back. */
  serviceName?: string;
  /** Rollback to this specific image tag. When omitted, the most recent previous tag is used. */
  targetTag?: string;
}

/**
 * Result returned by `runRollback()`.
 */
export interface RollbackResult {
  /** Per-service rollback results. */
  services: Array<{
    name: string;
    /** The image tag that was active before the rollback. */
    previousTag: string;
    /** The image tag deployed by the rollback. */
    rolledBackTag: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Roll back one or all deployed services on a stage to a previous image tag.
 *
 * For each service, resolves the target image tag (from `opts.targetTag` or
 * the most recent entry in `previousTags`), regenerates deployment files via
 * the stack's preset, applies user overrides, and calls `preset.deploy()`.
 * Updates the registry with the new deploy state.
 *
 * @param opts - Rollback options.
 * @returns A `RollbackResult` with per-service outcomes.
 *
 * @throws {Error} If the target stage is not found in the platform config.
 * @throws {Error} If the registry is not initialized.
 * @throws {Error} If no services are found for the target stage.
 *
 * @example
 * ```ts
 * import { runRollback } from '@lastshotlabs/slingshot-infra';
 *
 * const result = await runRollback({
 *   platform, infra, stageName: 'production',
 *   registry, presetRegistry, appRoot: process.cwd(),
 * });
 * ```
 */
export async function runRollback(opts: RollbackOptions): Promise<RollbackResult> {
  const { platform: rawPlatform, infra, stageName, registry, presetRegistry, appRoot } = opts;

  const platform = resolvePlatformConfig(rawPlatform, infra.platform);

  if (!Object.prototype.hasOwnProperty.call(platform.stages, stageName)) {
    throw new Error(
      `[slingshot-infra] Stage "${stageName}" not found in platform config. ` +
        `Available: ${Object.keys(platform.stages).join(', ')}`,
    );
  }
  const stage = platform.stages[stageName];

  // Acquire lock before reading to prevent TOCTOU race conditions.
  // Without this, another process could modify the registry between our read()
  // and write(), and those changes would be silently overwritten.
  const lock = await registry.lock();

  let registryDoc: Awaited<ReturnType<typeof registry.read>>;
  try {
    registryDoc = await registry.read();
  } catch (err) {
    await lock.release();
    throw err;
  }

  if (!registryDoc) {
    await lock.release();
    throw new Error('[slingshot-infra] Registry not initialized. Run: slingshot registry init');
  }

  // Determine which services to roll back
  const serviceNames = opts.serviceName
    ? [opts.serviceName]
    : Object.keys(registryDoc.services).filter(name =>
        Object.prototype.hasOwnProperty.call(registryDoc.services[name].stages, stageName),
      );

  if (serviceNames.length === 0) {
    await lock.release();
    throw new Error(`[slingshot-infra] No services found for stage "${stageName}" in registry.`);
  }

  const results: RollbackResult['services'] = [];
  const dockerRegistry = platform.defaults?.dockerRegistry ?? platform.org;

  try {
    for (const svcName of serviceNames) {
      const svcEntry = Object.prototype.hasOwnProperty.call(registryDoc.services, svcName)
        ? registryDoc.services[svcName]
        : undefined;
      if (!svcEntry) {
        results.push({
          name: svcName,
          previousTag: '',
          rolledBackTag: '',
          success: false,
          error: `Service "${svcName}" not found in registry.`,
        });
        continue;
      }

      const stageData = Object.prototype.hasOwnProperty.call(svcEntry.stages, stageName)
        ? svcEntry.stages[stageName]
        : undefined;
      if (!stageData) {
        results.push({
          name: svcName,
          previousTag: '',
          rolledBackTag: '',
          success: false,
          error: `Service "${svcName}" has no data for stage "${stageName}".`,
        });
        continue;
      }

      const currentTag = stageData.imageTag;

      // Resolve target tag
      let rollbackTag: string;
      if (opts.targetTag) {
        rollbackTag = opts.targetTag;
      } else {
        const previous = stageData.previousTags;
        if (!previous || previous.length === 0) {
          results.push({
            name: svcName,
            previousTag: currentTag,
            rolledBackTag: '',
            success: false,
            error: `No previous tags available for service "${svcName}" on stage "${stageName}".`,
          });
          continue;
        }
        rollbackTag = previous[previous.length - 1].imageTag;
      }

      // Find the stack and preset for this service
      const stackName = svcEntry.stack;
      const stackConfig = platform.stacks?.[stackName];
      if (!stackConfig) {
        results.push({
          name: svcName,
          previousTag: currentTag,
          rolledBackTag: rollbackTag,
          success: false,
          error: `Stack "${stackName}" not found in platform config.`,
        });
        continue;
      }

      const preset = presetRegistry.get(stackConfig.preset);
      const svcDecl = infra.services?.[svcName];

      const resolvedEnv = resolveEnvironment(platform, infra, stageName, registryDoc, svcDecl);

      const tempDir = mkdtempSync(join(tmpdir(), `slingshot-rollback-${svcName}-`));

      try {
        const ctx: PresetContext = {
          platform,
          infra,
          stage,
          stageName,
          stack: stackConfig,
          stackName,
          registry: registryDoc,
          resolvedEnv,
          appRoot,
          tempDir,
          serviceName: svcName,
          service: svcDecl,
          imageTag: rollbackTag,
          dockerRegistry,
        };

        let files = preset.generate(ctx);

        files = await Promise.all(
          files.map(f => {
            const overrideKey = mapFileToOverrideKey(f.path);
            let override = overrideKey
              ? infra.overrides?.[overrideKey as keyof typeof infra.overrides]
              : undefined;

            if (overrideKey === 'dockerfile') {
              const extractedName = extractServiceNameFromDockerfile(f.path);
              const svc = extractedName ? infra.services?.[extractedName] : undefined;
              if (svc?.dockerfile) {
                override = svc.dockerfile;
              }
            }

            return resolveOverride(f, override, appRoot);
          }),
        );

        for (const f of files) {
          const filePath = join(tempDir, f.path);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, f.content, 'utf-8');
        }

        const result = await preset.deploy(ctx, files);

        updateRegistryService(registryDoc, svcName, stackName, stageName, rollbackTag, result);

        results.push({
          name: svcName,
          previousTag: currentTag,
          rolledBackTag: rollbackTag,
          success: result.success,
          error: result.error,
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    // Write registry with the etag from the lock acquired before read
    await registry.write(registryDoc, lock.etag);
  } finally {
    await lock.release();
  }

  return { services: results };
}
