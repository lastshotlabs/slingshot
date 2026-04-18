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
 * Skips with a `console.warn` when `subjectField`, `id`, or `orgId` are absent
 * from the payload — this is a manifest authoring error, not a runtime crash.
 */
export function wireAutoGrant(
  bus: SlingshotEventBus,
  entityName: string,
  eventKey: string,
  config: AutoGrantConfig,
  resourceType: string,
  permissionsAdapter: PermissionsAdapter,
): void {
  const dynamicBus = bus as unknown as DynamicEventBus;

  dynamicBus.on(eventKey, async (payload: Record<string, unknown>) => {
    const subjectId = payload[config.subjectField] as string | undefined;
    const resourceId = payload.id as string | undefined;
    const tenantId = payload.orgId as string | undefined;

    if (!subjectId || !resourceId || !tenantId) {
      console.warn(
        `[autoGrant:${entityName}] Skipping grant — missing fields in payload.` +
          ` Expected: ${config.subjectField}, id, orgId.` +
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
