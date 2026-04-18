/**
 * activityLog wiring — subscribes to entity events and writes activity records
 * to a sibling entity adapter.
 */
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { ActivityLogConfig, ManifestEntity } from '../manifest/entityManifestSchema';

/** Dynamic event bus facade for string-keyed subscriptions. */
type DynamicEventBus = {
  on(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
};

/** Actor resolution order for activity log writes. */
const ACTOR_FIELDS = ['createdBy', 'updatedBy', 'actorId'] as const;

/**
 * Extract the event key string from a manifest route event declaration,
 * which can be either a plain string or an object with a `key` field.
 */
export function extractEventKey(
  event: string | { key: string; payload?: string[]; include?: string[] } | undefined,
): string | undefined {
  if (!event) return undefined;
  return typeof event === 'string' ? event : event.key;
}

/**
 * Build a map from event shortname (last `.`-separated segment) to full event key,
 * by scanning all event declarations on a manifest entity.
 */
export function buildEventKeyMap(entityDef: ManifestEntity): Record<string, string> {
  const map: Record<string, string> = {};

  function register(key: string | undefined) {
    if (!key) return;
    const shortname = key.split('.').at(-1);
    if (shortname) map[shortname] = key;
  }

  register(extractEventKey(entityDef.routes?.create?.event));
  register(extractEventKey(entityDef.routes?.update?.event));
  register(extractEventKey(entityDef.routes?.delete?.event));
  for (const opRoute of Object.values(entityDef.routes?.operations ?? {})) {
    register(extractEventKey((opRoute as { event?: string | { key: string } }).event));
  }

  return map;
}

/**
 * Subscribe to an entity's declared events and write activity records
 * to a sibling entity adapter on each event.
 *
 * Skips with a `console.warn` when `orgId` or `id` are absent from the payload.
 * Actor is resolved from payload fields: `createdBy` → `updatedBy` → `actorId` → `"system"`.
 */
export function wireActivityLog(
  bus: SlingshotEventBus,
  entityName: string,
  config: ActivityLogConfig,
  eventKeyMap: Record<string, string>,
  targetAdapter: { create(data: Record<string, unknown>): Promise<Record<string, unknown>> },
): void {
  const dynamicBus = bus as unknown as DynamicEventBus;

  for (const [shortname, eventConfig] of Object.entries(config.events)) {
    const eventKey = eventKeyMap[shortname];
    if (!eventKey) {
      console.warn(
        `[activityLog:${entityName}] No event key found for shortname "${shortname}". ` +
          `Declare the event on the entity's routes config.`,
      );
      continue;
    }

    dynamicBus.on(eventKey, async (payload: Record<string, unknown>) => {
      if (!payload.orgId || !payload.id) {
        console.warn(
          `[activityLog:${entityName}:${shortname}] Skipping — payload missing orgId or id.`,
        );
        return;
      }

      const actorId =
        (ACTOR_FIELDS.map(f => payload[f]).find(v => v != null) as string | undefined) ?? 'system';

      const meta =
        eventConfig.meta && eventConfig.meta.length > 0
          ? Object.fromEntries(eventConfig.meta.map(f => [f, payload[f] ?? null]))
          : null;

      await targetAdapter.create({
        orgId: payload.orgId as string,
        actorId,
        resourceType: config.resourceType,
        resourceId: payload.id as string,
        action: eventConfig.action,
        meta,
      });
    });
  }
}
