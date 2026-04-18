import type { DeployPlan, DeployPlanEntry } from './plan';

const STATUS_INDICATORS: Record<DeployPlanEntry['status'], string> = {
  add: '+',
  update: '~',
  unchanged: '=',
};

/**
 * Format a `DeployPlan` as a human-readable text table for CLI output.
 *
 * Each service entry is prefixed with `+` (add), `~` (update), or `=`
 * (unchanged). Changes are listed on indented sub-lines. The summary line
 * appears at the bottom.
 *
 * @param plan - The plan to format, as returned by `computeDeployPlan()`.
 * @returns A multi-line string suitable for `console.log()`.
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
 * //       image tag: abc123 (new)
 * // Plan: 1 to add, 0 to update, 0 unchanged
 * ```
 */
export function formatDeployPlan(plan: DeployPlan): string {
  const lines: string[] = [];

  lines.push('Deploy Plan');
  lines.push('==========');
  lines.push('');

  for (const entry of plan.services) {
    const indicator = STATUS_INDICATORS[entry.status];
    lines.push(`  ${indicator} ${entry.serviceName} (${entry.stackName})`);

    for (const change of entry.changes) {
      lines.push(`      ${change}`);
    }
  }

  lines.push('');

  const { additions, updates, unchanged } = plan.summary;
  lines.push(`Plan: ${additions} to add, ${updates} to update, ${unchanged} unchanged`);

  return lines.join('\n');
}
