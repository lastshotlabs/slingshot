import type { PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { getPluginStateOrNull } from '@lastshotlabs/slingshot-core';

/**
 * Result of `reconcileOrphanedOrgRecords`. Reports which dependent
 * collections still had orphaned rows when reconciliation began and which
 * (if any) failed to clean up. An empty `failed` list means the org has no
 * remaining orphans.
 */
export interface ReconcileOrphanedOrgRecordsResult {
  /** The org id that was checked. */
  readonly orgId: string;
  /** True when the org row no longer exists (the precondition for reconciling). */
  readonly orgGone: boolean;
  /** Collections that failed to clean up — same names used in 500 responses. */
  readonly failed: ReadonlyArray<string>;
}

/**
 * Operator-facing recovery API exposed by the organizations runtime via
 * pluginState. Removes orphaned member, invite, group, and group-membership
 * rows for an org id that has been deleted.
 *
 * Wire this method into a CLI command or admin route to remediate the 500
 * response from a partial cascade-delete on a non-atomic adapter (e.g. memory
 * or Mongo). Refuses to run if the org row still exists, since live orgs
 * should not have their dependents wiped.
 */
export interface OrganizationsReconcileService {
  reconcileOrphanedOrgRecords(orgId: string): Promise<ReconcileOrphanedOrgRecordsResult>;
}

/** pluginState key under which the reconcile service is published. */
export const ORGANIZATIONS_RECONCILE_STATE_KEY =
  'slingshot-organizations.reconcileService' as const;

function isOrganizationsReconcileService(value: unknown): value is OrganizationsReconcileService {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'reconcileOrphanedOrgRecords') === 'function'
  );
}

/**
 * Resolve the reconcile service from app pluginState. Throws if it has not
 * been published — typically because `setupPost` did not run yet.
 */
export function getOrganizationsReconcile(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): OrganizationsReconcileService {
  const service = getOrganizationsReconcileOrNull(input);
  if (!service) {
    throw new Error(
      '[slingshot-organizations] organizations reconcile service is not available in pluginState',
    );
  }
  return service;
}

/** Non-throwing variant for callers that need to probe availability. */
export function getOrganizationsReconcileOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): OrganizationsReconcileService | null {
  const pluginState = getPluginStateOrNull(input);
  const service = pluginState?.get(ORGANIZATIONS_RECONCILE_STATE_KEY);
  return isOrganizationsReconcileService(service) ? service : null;
}
