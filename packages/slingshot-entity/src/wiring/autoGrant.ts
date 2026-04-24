/**
 * autoGrant wiring — subscribes to entity create events and calls
 * `permissionsAdapter.createGrant()` when the event fires with a valid payload.
 */
import type { PermissionsAdapter, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { AutoGrantConfig } from '../manifest/entityManifestSchema';

/** Dynamic event bus facade for string-keyed subscriptions. */
type DynamicEventBus = {
  on(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
};

/**
 * Subscribe to an entity's create event and call `permissionsAdapter.createGrant()`
 * when the event fires with a valid payload.
 *
 * Each field used for resource ID and tenant ID resolution follows a three-tier
 * priority chain:
 *
 * 1. **Explicit config fields** — `config.resourceIdField`, `config.tenantIdField`
 *    (highest priority, set by the user in manifest config).
 * 2. **Resolved entity fields** — `resolvedFields.pkField`, `resolvedFields.tenantField`
 *    (derived from the entity definition at wiring time).
 * 3. **Hardcoded defaults** — `'id'` for resource, `'orgId'` for tenant (lowest priority).
 *
 * The subject ID is always read from `config.subjectField` with no fallback chain.
 *
 * Skips with a `console.warn` when any of the three required fields (subject,
 * resource, tenant) are absent from the event payload.
 *
 * @param bus - The Slingshot event bus instance to subscribe on.
 * @param entityName - The entity name, used in warning messages for diagnostics.
 * @param eventKey - The fully qualified event key to subscribe to (typically the
 *   entity's create event).
 * @param config - The auto-grant configuration declaring the subject field, role
 *   to grant, and optional field overrides for resource and tenant IDs.
 * @param resourceType - The permission resource type label passed to the grant
 *   (usually the entity name).
 * @param permissionsAdapter - The permissions adapter whose `createGrant()` method
 *   will be called when the event fires with a complete payload.
 * @param resolvedFields - Optional entity-derived field names resolved at wiring time.
 *   `pkField` is the entity's primary key field name; `tenantField` is the entity's
 *   tenant scoping field name. Used as fallbacks when explicit config fields are not set.
 *
 * @example
 * ```ts
 * wireAutoGrant(bus, 'project', 'project.created', grantConfig, 'project', permAdapter, {
 *   pkField: 'projectId',
 *   tenantField: 'workspaceId',
 * });
 * ```
 */
export function wireAutoGrant(
  bus: SlingshotEventBus,
  entityName: string,
  eventKey: string,
  config: AutoGrantConfig,
  resourceType: string,
  permissionsAdapter: PermissionsAdapter,
  resolvedFields?: { pkField?: string; tenantField?: string },
): void {
  const dynamicBus = bus as unknown as DynamicEventBus;
  const resourceIdKey = config.resourceIdField ?? resolvedFields?.pkField ?? 'id';
  const tenantIdKey = config.tenantIdField ?? resolvedFields?.tenantField ?? 'orgId';

  dynamicBus.on(eventKey, async (payload: Record<string, unknown>) => {
    const subjectId = payload[config.subjectField] as string | undefined;
    const resourceId = payload[resourceIdKey] as string | undefined;
    const tenantId = payload[tenantIdKey] as string | undefined;

    if (!subjectId || !resourceId || !tenantId) {
      console.warn(
        `[autoGrant:${entityName}] Skipping grant — missing fields in payload.` +
          ` Expected: ${config.subjectField}, ${resourceIdKey}, ${tenantIdKey}.` +
          ` Got: ${JSON.stringify(Object.keys(payload))}`,
      );
      return;
    }

    await permissionsAdapter.createGrant({
      subjectId,
      subjectType: 'user',
      tenantId,
      resourceType,
      resourceId,
      roles: [config.role],
      effect: 'allow',
      grantedBy: 'system',
    });
  });
}
