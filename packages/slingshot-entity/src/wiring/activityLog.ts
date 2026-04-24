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

/** Default actor resolution order for activity log writes. */
const DEFAULT_ACTOR_FIELDS = ['createdBy', 'updatedBy', 'actorId'] as const;

/**
 * Extract the event key string from a manifest route event declaration,
 * which can be either a plain string or an object with a `key` field.
 *
 * @param event - The route event declaration. Can be a plain event key string,
 *   an object containing a `key` field (with optional `payload` and `include` arrays),
 *   or `undefined` when no event is declared.
 * @returns The resolved event key string, or `undefined` when no event is declared.
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
 *
 * Scans `create`, `update`, `delete`, and all custom `operations` routes on the
 * entity definition, extracting each declared event key and indexing it by its
 * shortname (the final dot-separated segment).
 *
 * @param entityDef - The manifest entity definition whose route events will be scanned.
 * @returns A record mapping each event shortname to its full qualified event key string.
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
 * Each field used for tenant ID, resource ID, and actor ID resolution follows
 * a three-tier priority chain:
 *
 * 1. **Explicit config fields** — `config.tenantIdField`, `config.resourceIdField`,
 *    `config.actorIdFields` (highest priority, set by the user in manifest config).
 * 2. **Resolved entity fields** — `resolvedFields.tenantField`, `resolvedFields.pkField`
 *    (derived from the entity definition at wiring time).
 * 3. **Hardcoded defaults** — `'orgId'` for tenant, `'id'` for resource,
 *    `['createdBy', 'updatedBy', 'actorId']` for actor (lowest priority).
 *
 * Skips individual events with a `console.warn` when the tenant or resource
 * field is absent from the event payload.
 *
 * @param bus - The Slingshot event bus instance to subscribe on.
 * @param entityName - The entity name, used in warning messages for diagnostics.
 * @param config - The activity log configuration declaring which events to track,
 *   the resource type label, and optional field overrides.
 * @param eventKeyMap - A shortname-to-full-key map (built via {@link buildEventKeyMap})
 *   used to resolve the event keys referenced in `config.events`.
 * @param targetAdapter - The persistence adapter for the activity log entity.
 *   Must expose a `create()` method that accepts a record and persists it.
 * @param resolvedFields - Optional entity-derived field names resolved at wiring time.
 *   `pkField` is the entity's primary key field name; `tenantField` is the entity's
 *   tenant scoping field name. Used as fallbacks when explicit config fields are not set.
 *
 * @example
 * ```ts
 * wireActivityLog(bus, 'project', activityConfig, eventKeyMap, activityAdapter, {
 *   pkField: 'projectId',
 *   tenantField: 'workspaceId',
 * });
 * ```
 */
export function wireActivityLog(
  bus: SlingshotEventBus,
  entityName: string,
  config: ActivityLogConfig,
  eventKeyMap: Record<string, string>,
  targetAdapter: { create(data: Record<string, unknown>): Promise<Record<string, unknown>> },
  resolvedFields?: { pkField?: string; tenantField?: string },
): void {
  const dynamicBus = bus as unknown as DynamicEventBus;
  const tenantIdKey = config.tenantIdField ?? resolvedFields?.tenantField ?? 'orgId';
  const resourceIdKey = config.resourceIdField ?? resolvedFields?.pkField ?? 'id';
  const actorFields = config.actorIdFields ?? [...DEFAULT_ACTOR_FIELDS];

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
      const tenantId = payload[tenantIdKey];
      const resourceId = payload[resourceIdKey];

      if (!tenantId || !resourceId) {
        console.warn(
          `[activityLog:${entityName}:${shortname}] Skipping — payload missing ${tenantIdKey} or ${resourceIdKey}.`,
        );
        return;
      }

      const actorId =
        (actorFields.map(f => payload[f]).find(v => v != null) as string | undefined) ?? 'system';

      const meta =
        eventConfig.meta && eventConfig.meta.length > 0
          ? Object.fromEntries(eventConfig.meta.map(f => [f, payload[f] ?? null]))
          : null;

      await targetAdapter.create({
        orgId: tenantId as string,
        actorId,
        resourceType: config.resourceType,
        resourceId: resourceId as string,
        action: eventConfig.action,
        meta,
      });
    });
  }
}
