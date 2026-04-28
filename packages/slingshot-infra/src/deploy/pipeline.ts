import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvePlatformConfig } from '../config/resolvePlatformConfig';
import { resolveRepoIdentity } from '../config/resolveRepoIdentity';
import { createDnsManager } from '../dns/manager';
import { resolveOverride } from '../override/resolveOverrides';
import { resolveDomain } from '../preset/resolveDomain';
import type { DefineInfraConfig, ServiceDeclaration } from '../types/infra';
import type { DefinePlatformConfig } from '../types/platform';
import type { DeployResult, PresetContext, PresetProvider, SiblingService } from '../types/preset';
import type { RegistryDocument, RegistryLock, RegistryProvider } from '../types/registry';
import { extractServiceNameFromDockerfile, mapFileToOverrideKey } from './overrideMapping';
import type { DeployPlan } from './plan';
import { computeDeployPlan } from './plan';
import { resolveEnvironment } from './resolveEnv';

/**
 * Options for `runDeployPipeline()`.
 */
export interface DeployPipelineOptions {
  /** Frozen platform config from `definePlatform()`. */
  platform: DefinePlatformConfig;
  /** Frozen infra config from `defineInfra()`. */
  infra: DefineInfraConfig;
  /** Deployment stage to target (e.g. `'production'`). */
  stageName: string;
  /** Registry provider for reading/writing deploy state. */
  registry: RegistryProvider;
  /** Preset registry providing preset instances by name. */
  presetRegistry: { get(name: string): PresetProvider };
  /** Absolute path to the app root directory. */
  appRoot: string;
  /**
   * When `true`, prints generated file contents to stdout instead of
   * deploying. Does not write to the registry.
   */
  dryRun?: boolean;
  /**
   * When `true`, returns a `DeployPlan` showing what would change without
   * executing the deploy. Skips the registry lock.
   */
  plan?: boolean;
}

/**
 * Result returned by `runDeployPipeline()`.
 */
export interface DeployPipelineResult {
  /** Per-service deploy results. Empty when `plan: true`. */
  services: Array<{
    name: string;
    stack: string;
    result: DeployResult;
  }>;
  /** Populated when `plan: true`. */
  plan?: DeployPlan;
}

interface ResolvedService {
  name: string;
  stacks: string[];
  service?: ServiceDeclaration;
}

interface StackDeployGroup {
  stackName: string;
  preset: PresetProvider;
  services: ResolvedService[];
  envByService: Record<string, Record<string, string>>;
}

/**
 * Run the full deploy pipeline for an app.
 *
 * Groups services by stack, generates deployment files via the stack's preset,
 * applies user overrides, copies files to a temp directory, and calls
 * `preset.deploy()`. After a successful deploy, updates DNS records if
 * `platform.dns` is configured and writes the updated registry document.
 *
 * When `opts.plan` is `true`, returns a `DeployPlan` without executing.
 * When `opts.dryRun` is `true`, prints generated files and returns without
 * writing to the registry.
 *
 * @param opts - Pipeline options including platform, infra, stage, and registry.
 * @returns A `DeployPipelineResult` with per-service results and optionally a plan.
 *
 * @throws {Error} If the target stage is not found in `platform.stages`
 *   (message: `'Stage "<name>" not found in platform config'`).
 * @throws {Error} If the registry document has not been initialized — run
 *   `slingshot registry init` first (message: `'Registry not initialized'`).
 * @throws {Error} If a service references a stack not defined in
 *   `platform.stacks` (message: `'Stack "<name>" not found in platform config'`).
 * @throws {Error} If `infra.platform` names a platform entry that does not
 *   exist in `rawPlatform.platforms` (thrown by `resolvePlatformConfig`).
 *
 * @example
 * ```ts
 * import { runDeployPipeline } from '@lastshotlabs/slingshot-infra';
 *
 * const result = await runDeployPipeline({
 *   platform, infra, stageName: 'production',
 *   registry, presetRegistry, appRoot: process.cwd(),
 * });
 * ```
 */
export async function runDeployPipeline(
  opts: DeployPipelineOptions,
): Promise<DeployPipelineResult> {
  const { platform: rawPlatform, infra, stageName, registry, presetRegistry, appRoot } = opts;

  // Resolve multi-platform targeting: if infra specifies a platform name,
  // use that platform entry's stages/stacks/resources instead of the top-level ones
  const platform = resolvePlatformConfig(rawPlatform, infra.platform);

  if (!Object.prototype.hasOwnProperty.call(platform.stages, stageName)) {
    throw new Error(
      `[slingshot-infra] Stage "${stageName}" not found in platform config. ` +
        `Available: ${Object.keys(platform.stages).join(', ')}`,
    );
  }
  const stage = platform.stages[stageName];

  if (opts.plan) {
    const registryDoc = await registry.read();
    if (!registryDoc) {
      throw new Error('[slingshot-infra] Registry not initialized. Run: slingshot registry init');
    }
    const imageTag = generateImageTag();
    const deployPlan = computeDeployPlan({
      infra,
      stageName,
      registry: registryDoc,
      imageTag,
    });
    return { services: [], plan: deployPlan };
  }

  const repoIdentity = infra.repo ?? resolveRepoIdentity(appRoot);
  const lock: RegistryLock = await registry.lock(120000);

  const results: DeployPipelineResult['services'] = [];
  try {
    const registryDoc = await registry.read();
    if (!registryDoc) {
      throw new Error('[slingshot-infra] Registry not initialized. Run: slingshot registry init');
    }

    const allServices = resolveServices(infra);
    const stackGroups = groupByStack(
      allServices,
      platform,
      infra,
      stageName,
      registryDoc,
      presetRegistry,
    );
    const imageTag = generateImageTag();
    const dockerRegistry = platform.defaults?.dockerRegistry ?? platform.org;

    for (const group of stackGroups) {
      const tempDir = mkdtempSync(join(tmpdir(), `slingshot-deploy-${group.stackName}-`));

      try {
        const stackConfig = platform.stacks?.[group.stackName];
        if (!stackConfig) {
          throw new Error(
            `[slingshot-infra] Stack "${group.stackName}" not found in platform config. ` +
              `Available: ${Object.keys(platform.stacks ?? {}).join(', ')}`,
          );
        }
        const isSingleService = group.services.length === 1;

        const resolvedEnv: Record<string, string> | Record<string, Record<string, string>> =
          isSingleService ? group.envByService[group.services[0].name] : group.envByService;

        const siblingServices: SiblingService[] = Object.entries(registryDoc.services)
          .filter(
            ([, svc]) =>
              svc.stack === group.stackName &&
              svc.repo !== repoIdentity &&
              Object.prototype.hasOwnProperty.call(svc.stages, stageName) &&
              svc.stages[stageName].status === 'deployed',
          )
          .map(([name, svc]) => ({ name, ...svc }));

        const ctx: PresetContext = {
          platform,
          infra,
          stage,
          stageName,
          stack: stackConfig,
          stackName: group.stackName,
          registry: registryDoc,
          resolvedEnv,
          appRoot,
          tempDir,
          serviceName: isSingleService ? group.services[0].name : 'stack',
          service: isSingleService ? group.services[0].service : undefined,
          imageTag,
          dockerRegistry,
          siblingServices,
        };

        let files = group.preset.generate(ctx);

        files = await Promise.all(
          files.map(f => {
            const overrideKey = mapFileToOverrideKey(f.path);
            let override = overrideKey
              ? infra.overrides?.[overrideKey as keyof typeof infra.overrides]
              : undefined;

            if (overrideKey === 'dockerfile') {
              const svcName = extractServiceNameFromDockerfile(f.path);
              const svc = svcName ? infra.services?.[svcName] : undefined;
              if (svc?.dockerfile) {
                override = svc.dockerfile;
              }
            }

            return resolveOverride(f, override, appRoot);
          }),
        );

        if (opts.dryRun) {
          for (const f of files) {
            console.log(`--- ${f.path} ---`);
            console.log(f.content);
            console.log('');
          }
          for (const svc of group.services) {
            results.push({ name: svc.name, stack: group.stackName, result: { success: true } });
          }
          continue;
        }

        for (const f of files) {
          const filePath = join(tempDir, f.path);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, f.content, 'utf-8');
        }

        const result = await group.preset.deploy(ctx, files);

        for (const svc of group.services) {
          const serviceConfig = infra.services?.[svc.name];
          const baseDomain = serviceConfig?.domain ?? (!infra.services ? infra.domain : undefined);
          const domainConfig = serviceConfig?.domains?.[svc.name] ?? infra.domains?.[svc.name];
          const domain = baseDomain
            ? resolveDomain(baseDomain, stageName, stage, domainConfig)
            : undefined;
          const env = isSingleService
            ? group.envByService[group.services[0].name]
            : group.envByService[svc.name];

          updateRegistryService(
            registryDoc,
            svc.name,
            group.stackName,
            stageName,
            imageTag,
            result,
            repoIdentity,
            {
              port: serviceConfig?.port ?? infra.port,
              domain,
              image: `${dockerRegistry}/${svc.name}:${imageTag}`,
              uses: serviceConfig?.uses ?? [],
              env,
            },
          );
          results.push({ name: svc.name, stack: group.stackName, result });
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    // After successful deployments, update DNS records if configured
    if (!opts.dryRun && platform.dns) {
      const dnsManager = createDnsManager(platform.dns);
      for (const entry of results) {
        if (!entry.result.success || !entry.result.serviceUrl) continue;

        const svc = infra.services?.[entry.name];
        const baseDomain = svc?.domain ?? (!infra.services ? infra.domain : undefined);
        if (!baseDomain) continue;

        const domainConfig = svc?.domains?.[entry.name] ?? infra.domains?.[entry.name];
        const domain = resolveDomain(baseDomain, stageName, stage, domainConfig);

        try {
          await dnsManager.ensureRecords({ domain, target: entry.result.serviceUrl });
        } catch (err) {
          console.error(`[dns] Failed to update DNS for ${domain}:`, err);
        }
      }
    }

    if (!opts.dryRun) {
      // Auto-register/update the app entry for cross-repo coordination
      const appName = infra.appName ?? repoIdentity;
      if (appName) {
        const allStacks = [...new Set(stackGroups.map(g => g.stackName))];
        const allUses = infra.uses ?? [];
        if (!registryDoc.apps) {
          registryDoc.apps = {};
        }
        registryDoc.apps[appName] = {
          name: appName,
          repo: repoIdentity,
          stacks: allStacks,
          uses: allUses,
          registeredAt: new Date().toISOString(),
        };
      }

      await registry.write(registryDoc, lock.etag);
    }
  } finally {
    await lock.release();
  }

  return { services: results };
}

/**
 * Expand `infra.services` into a flat `ResolvedService[]`.
 *
 * When `infra.services` is defined each entry is returned with its
 * `service.stacks` override (or `infra.stacks` as fallback) and the original
 * `ServiceDeclaration`. When `infra.services` is absent (single-service apps)
 * a single `{ name: 'default', stacks: infra.stacks ?? [] }` entry is returned
 * with no `service` declaration.
 *
 * @param infra - The frozen infra config from `defineInfra()`.
 * @returns Flat array of resolved services with their stack assignments.
 */
function resolveServices(infra: DefineInfraConfig): ResolvedService[] {
  if (infra.services) {
    return Object.entries(infra.services).map(([name, service]) => ({
      name,
      stacks: service.stacks ?? infra.stacks ?? [],
      service,
    }));
  }
  return [{ name: 'default', stacks: infra.stacks ?? [] }];
}

/**
 * Group resolved services by their target stack and instantiate the preset for
 * each stack.
 *
 * Iterates over every `(service, stackName)` pair and accumulates services into
 * per-stack `StackDeployGroup` entries. For each service it calls
 * `resolveEnvironment()` to pre-compute the env map. The preset instance is
 * resolved once per stack from `presetRegistry.get(stackConfig.preset)`.
 *
 * @param services - Flat service list from `resolveServices()`.
 * @param platform - Resolved platform config for this deploy.
 * @param infra - Frozen infra config from `defineInfra()`.
 * @param stageName - The deployment stage being targeted.
 * @param registryDoc - Current registry document (used by `resolveEnvironment`).
 * @param presetRegistry - Preset registry to look up preset instances by name.
 * @returns One `StackDeployGroup` per distinct stack referenced by any service.
 *
 * @throws {Error} If a service references a stack not present in `platform.stacks`.
 */
function groupByStack(
  services: ResolvedService[],
  platform: DefinePlatformConfig,
  infra: DefineInfraConfig,
  stageName: string,
  registryDoc: RegistryDocument,
  presetRegistry: { get(name: string): PresetProvider },
): StackDeployGroup[] {
  const groups = new Map<string, StackDeployGroup>();

  for (const svc of services) {
    for (const stackName of svc.stacks) {
      const stackConfig = platform.stacks?.[stackName];
      if (!stackConfig) {
        throw new Error(
          `[slingshot-infra] Stack "${stackName}" not found in platform config. ` +
            `Available: ${Object.keys(platform.stacks ?? {}).join(', ')}`,
        );
      }

      if (!groups.has(stackName)) {
        groups.set(stackName, {
          stackName,
          preset: presetRegistry.get(stackConfig.preset),
          services: [],
          envByService: {},
        });
      }

      const group = groups.get(stackName);
      if (!group) {
        throw new Error(
          `[slingshot-infra] Failed to initialize deploy group for stack "${stackName}"`,
        );
      }
      group.services.push(svc);
      group.envByService[svc.name] = resolveEnvironment(
        platform,
        infra,
        stageName,
        registryDoc,
        svc.service,
      );
    }
  }

  return [...groups.values()];
}

/**
 * Generate a unique, time-sortable image tag for a deploy.
 *
 * Format: `YYYYMMDD-HHmmss-<4-char random suffix>` (UTC).
 *
 * @returns A string like `'20240315-143022-a4f7'`.
 *
 * @remarks
 * The 4-char suffix uses `Math.random()` because this is purely a uniqueness
 * tiebreaker for deploys that land in the same second — it is NOT a credential
 * or secret. The image tag is publicly visible in the registry; predictability
 * has no security impact.
 */
function generateImageTag(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  // Non-security: dedup suffix for same-second deploys, not a secret.
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${time}-${rand}`;
}

/**
 * Update (or create) a service entry in a `RegistryDocument` after a deploy.
 *
 * If the service already exists in the document, its metadata is updated in
 * place. The current image tag is pushed to `previousTags` so rollbacks can
 * find it. The `status` field reflects whether the deploy succeeded.
 *
 * @param doc - The `RegistryDocument` to mutate.
 * @param serviceName - Logical service name (key in `doc.services`).
 * @param stackName - Stack the service was deployed to.
 * @param stageName - Stage the service was deployed to.
 * @param imageTag - New image tag applied to the deploy.
 * @param result - Result returned by the preset's `deploy()` method.
 * @param repo - Repository identifier for cross-repo coordination.
 * @param metadata - Optional port, domain, image URI, resource uses, and env vars.
 */
export function updateRegistryService(
  doc: RegistryDocument,
  serviceName: string,
  stackName: string,
  stageName: string,
  imageTag: string,
  result: DeployResult,
  repo?: string,
  metadata?: {
    port?: number;
    domain?: string;
    image?: string;
    uses?: string[];
    env?: Record<string, string>;
  },
): void {
  const serviceEntry = Object.prototype.hasOwnProperty.call(doc.services, serviceName)
    ? doc.services[serviceName]
    : undefined;

  if (!serviceEntry) {
    doc.services[serviceName] = {
      stack: stackName,
      repo: repo ?? '',
      uses: metadata?.uses ?? [],
      env: metadata?.env,
      port: metadata?.port,
      domain: metadata?.domain,
      image: metadata?.image,
      stages: {},
    };
  } else if (repo) {
    serviceEntry.repo = repo;
    if (metadata?.uses) serviceEntry.uses = metadata.uses;
    if (metadata?.env) serviceEntry.env = metadata.env;
    if (metadata?.port !== undefined) serviceEntry.port = metadata.port;
    if (metadata?.domain !== undefined) serviceEntry.domain = metadata.domain;
    if (metadata?.image !== undefined) serviceEntry.image = metadata.image;
  }

  const currentService = doc.services[serviceName];
  const existingStage = Object.prototype.hasOwnProperty.call(currentService.stages, stageName)
    ? currentService.stages[stageName]
    : undefined;
  const previousTags = existingStage?.previousTags ?? [];

  // Push the current tag to history before overwriting (if there is one)
  if (existingStage) {
    previousTags.push({ imageTag: existingStage.imageTag, deployedAt: existingStage.deployedAt });
  }

  currentService.stages[stageName] = {
    imageTag,
    deployedAt: new Date().toISOString(),
    status: result.success ? 'deployed' : 'failed',
    previousTags,
  };
}
