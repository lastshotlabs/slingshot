import type { DefineInfraConfig } from '../types/infra';
import type { RegistryDocument, RegistryServiceEntry } from '../types/registry';

/**
 * A computed deploy plan describing what `runDeployPipeline()` would change.
 */
export interface DeployPlan {
  /** Per-service plan entries. */
  services: DeployPlanEntry[];
  /** Aggregate counts for display. */
  summary: { additions: number; updates: number; unchanged: number };
}

/**
 * Plan entry for a single service/stack combination.
 */
export interface DeployPlanEntry {
  /** Logical service name. */
  serviceName: string;
  /** Stack the service deploys to. */
  stackName: string;
  /**
   * Change type:
   * - `'add'`: service has never been deployed to this stage.
   * - `'update'`: service exists with a different image tag.
   * - `'unchanged'`: service is already at this image tag.
   */
  status: 'add' | 'update' | 'unchanged';
  /** Current image tag (if service already exists in the registry). */
  currentImageTag?: string;
  /** Image tag that would be applied by the deploy. */
  newImageTag: string;
  /** Current deploy status from the registry (e.g. `'deployed'`). */
  currentStatus?: string;
  /** Human-readable change descriptions (e.g. `'image tag: abc → def'`). */
  changes: string[];
}

/**
 * Options for `computeDeployPlan()`.
 */
export interface ComputeDeployPlanOptions {
  /** Frozen infra config from `defineInfra()`. */
  infra: DefineInfraConfig;
  /** Deployment stage to compute the plan for. */
  stageName: string;
  /** Current registry document representing the deployed state. */
  registry: RegistryDocument;
  /** Image tag that would be applied by the deploy. */
  imageTag: string;
}

/**
 * Compute a deploy plan without executing it.
 *
 * Compares the current registry state against the desired set of
 * service/stack deployments and produces a `DeployPlan` with per-service
 * `'add'`, `'update'`, or `'unchanged'` entries and aggregate summary counts.
 *
 * @remarks
 * **Algorithm:**
 * 1. Calls `resolveServiceStacks()` to expand `infra.services` (or produce a
 *    single `'default'` entry) into `{ name, stacks }` pairs.
 * 2. For each `(service, stack)` pair, looks up the service in
 *    `registry.services[name]` and then `service.stages[stageName]`:
 *    - Missing service or stage entry → `'add'` with change descriptions.
 *    - Stage entry with matching `imageTag` → `'unchanged'`.
 *    - Stage entry with a different `imageTag` → `'update'` with a
 *      `'image tag: old → new'` change description. If the stack name also
 *      changed a second change description is appended.
 * 3. Aggregates counts into `summary.additions`, `summary.updates`, and
 *    `summary.unchanged`.
 *
 * The function is pure — it never writes to the registry or touches the
 * filesystem. Pass the result to `formatDeployPlan()` for CLI display.
 *
 * @param opts - Plan computation options.
 * @returns A `DeployPlan` suitable for display via `formatDeployPlan()`.
 *
 * @example
 * ```ts
 * import { computeDeployPlan, formatDeployPlan } from '@lastshotlabs/slingshot-infra';
 *
 * const plan = computeDeployPlan({ infra, stageName: 'production', registry: doc, imageTag });
 * console.log(formatDeployPlan(plan));
 * // Deploy Plan
 * // ==========
 * //   + api (main-stack)
 * //       stack: main-stack (new)
 * //       image tag: 20240101-120000-ab12 (new)
 * // Plan: 1 to add, 0 to update, 0 unchanged
 * ```
 */
export function computeDeployPlan(opts: ComputeDeployPlanOptions): DeployPlan {
  const { infra, stageName, registry, imageTag } = opts;

  const resolvedServices = resolveServiceStacks(infra);
  const entries: DeployPlanEntry[] = [];

  for (const { name, stacks } of resolvedServices) {
    for (const stackName of stacks) {
      const existing: RegistryServiceEntry | undefined = Object.prototype.hasOwnProperty.call(
        registry.services,
        name,
      )
        ? registry.services[name]
        : undefined;
      const stageEntry =
        existing && Object.prototype.hasOwnProperty.call(existing.stages, stageName)
          ? existing.stages[stageName]
          : undefined;

      if (!existing || !stageEntry) {
        const changes: string[] = [`stack: ${stackName} (new)`, `image tag: ${imageTag} (new)`];
        entries.push({
          serviceName: name,
          stackName,
          status: 'add',
          newImageTag: imageTag,
          changes,
        });
      } else if (stageEntry.imageTag === imageTag) {
        entries.push({
          serviceName: name,
          stackName: existing.stack,
          status: 'unchanged',
          currentImageTag: stageEntry.imageTag,
          newImageTag: imageTag,
          currentStatus: stageEntry.status,
          changes: [],
        });
      } else {
        const changes: string[] = [`image tag: ${stageEntry.imageTag} \u2192 ${imageTag}`];
        if (existing.stack !== stackName) {
          changes.push(`stack: ${existing.stack} \u2192 ${stackName}`);
        }
        entries.push({
          serviceName: name,
          stackName,
          status: 'update',
          currentImageTag: stageEntry.imageTag,
          newImageTag: imageTag,
          currentStatus: stageEntry.status,
          changes,
        });
      }
    }
  }

  const summary = {
    additions: entries.filter(e => e.status === 'add').length,
    updates: entries.filter(e => e.status === 'update').length,
    unchanged: entries.filter(e => e.status === 'unchanged').length,
  };

  return { services: entries, summary };
}

interface ResolvedServiceStack {
  name: string;
  stacks: string[];
}

/**
 * Expand `infra.services` into a flat list of `{ name, stacks }` pairs.
 *
 * When `infra.services` is defined, each entry is expanded using its own
 * `service.stacks` override if present, falling back to `infra.stacks`.
 * When `infra.services` is absent (single-service apps), a single entry
 * named `'default'` is returned using `infra.stacks` (or an empty array).
 *
 * @param infra - The frozen infra config from `defineInfra()`.
 * @returns An array of `{ name, stacks }` pairs, one per declared service.
 */
function resolveServiceStacks(infra: DefineInfraConfig): ResolvedServiceStack[] {
  if (infra.services) {
    return Object.entries(infra.services).map(([name, service]) => ({
      name,
      stacks: service.stacks ?? infra.stacks ?? [],
    }));
  }
  return [{ name: 'default', stacks: infra.stacks ?? [] }];
}
