/**
 * applyChannelConfig — builds subscribe guards and event forwarding for
 * config-driven WebSocket entity channels.
 *
 * Two responsibilities:
 * 1. Subscribe guard: parses room names, enforces auth/permissions/middleware
 * 2. Event forwarding: wires bus events to WS room publish calls
 */
import type {
  Actor,
  ChannelIncomingEventDeclaration,
  EntityChannelConfig,
  EntityChannelDeclaration,
  ResolvedEntityConfig,
  SlingshotEventBus,
  WsPublishFn,
  WsState,
} from '@lastshotlabs/slingshot-core';
import { isValidRoomName } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * Runtime dependencies for `buildSubscribeGuard()`.
 *
 * Provides identity resolution, permission checking, named middleware
 * handlers, and an optional entity loader for ownership checks.
 *
 * @example
 * ```ts
 * import type { ChannelConfigDeps } from '@lastshotlabs/slingshot-entity';
 *
 * const deps: ChannelConfigDeps = {
 *   getActor: (ws) => (ws as MyWs).data?.actor ?? null,
 *   checkPermission: async (actor, perm, scope) =>
 *     permEvaluator.can(
 *       { subjectId: actor.id ?? '', subjectType: actor.kind === 'user' ? 'user' : 'service' },
 *       perm,
 *       scope,
 *     ),
 *   middleware: {
 *     requireRoomMember: async (ws, { entityId }) => isMember(ws, entityId),
 *   },
 *   getEntity: async (storageName, id) => db.findById(storageName, id),
 * };
 * ```
 */
export interface ChannelConfigDeps {
  /**
   * Resolve the authenticated `Actor` from a WebSocket connection.
   *
   * @param ws - The WebSocket connection object (opaque).
   * @returns The connecting `Actor`, or `null` when the connection is anonymous.
   *   Returning `null` denies any subscription that requires identity.
   */
  getActor: (ws: unknown) => Actor | null;

  /**
   * Check whether the actor has a specific permission, optionally scoped.
   *
   * Permission backends decide how to map the actor onto their subject model
   * (e.g. `subjectType: 'user'` when `actor.kind === 'user'`,
   * `subjectType: 'service'` for service accounts). The channel runtime does
   * not hardcode a subject type at this boundary.
   *
   * @param actor - The connecting `Actor` (already non-anonymous when this is called).
   * @param requires - The permission string to check (e.g. `'message:read'`).
   * @param scope - Optional scope parameters for the permission check.
   * @returns `true` when the actor is authorized, `false` otherwise.
   */
  checkPermission: (
    actor: Actor,
    requires: string,
    scope?: Record<string, string>,
  ) => boolean | Promise<boolean>;

  /**
   * Named middleware handlers referenced by channel `middleware` arrays.
   *
   * Keys must match the names used in the channel declarations.
   */
  middleware: Record<string, ChannelMiddlewareHandler>;

  /**
   * Resolve an entity record by storage name and ID.
   *
   * Required when any channel declaration uses `permission.ownerField`. The
   * guard loads the entity and compares `entity[ownerField]` to the
   * subscriber's `userId`. If omitted and an `ownerField` check is required,
   * the guard denies the subscription.
   *
   * @param storageName - The entity's `_storageName`.
   * @param entityId - The entity ID parsed from the room name.
   * @returns The entity record, or `null` when not found.
   */
  getEntity?: (
    storageName: string,
    entityId: string,
  ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
}

/**
 * A named WebSocket channel middleware handler.
 *
 * Called by `buildSubscribeGuard()` for each middleware name listed in a
 * channel declaration. Return `false` (or throw) to deny the subscription.
 *
 * @param ws - The WebSocket connection object.
 * @param context - Parsed room context with `storageName`, `entityId`, and
 *   `channelName`.
 * @returns `true` to allow, `false` to deny.
 *
 * @example
 * ```ts
 * import type { ChannelMiddlewareHandler } from '@lastshotlabs/slingshot-entity';
 *
 * const requireRoomMember: ChannelMiddlewareHandler = async (ws, { entityId }) => {
 *   const actorId = (ws as MyWs).data?.actor?.id;
 *   if (!actorId) return false;
 *   return roomMembershipStore.isMember(entityId, actorId);
 * };
 * ```
 */
export type ChannelMiddlewareHandler = (
  ws: unknown,
  context: { storageName: string; entityId: string; channelName: string },
) => boolean | Promise<boolean>;

// WsPublishFn is defined in slingshot-core and re-exported here for consumers
// that import it from slingshot-entity.
export type { WsPublishFn };

// ---------------------------------------------------------------------------
// Room name parsing
// ---------------------------------------------------------------------------

/**
 * The three components of a WebSocket room name after parsing.
 *
 * Room names follow the convention `{storageName}:{entityId}:{channelName}`
 * (colon-separated, exactly three segments). For example:
 * `'messages:msg_abc123:activity'`.
 *
 * @remarks
 * `storageName` is the entity's `_storageName` (plural snake_case),
 * `entityId` is the primary key value, and `channelName` is the declared
 * channel name from `EntityChannelConfig.channels`.
 */
interface ParsedRoom {
  storageName: string;
  entityId: string;
  channelName: string;
}

/**
 * Parse a WebSocket room name into its three structural components.
 *
 * @param room - The raw room name string (e.g.
 *   `'messages:msg_abc123:activity'`).
 * @returns A `ParsedRoom` when the string has exactly three non-empty colon-
 *   separated segments, or `null` when the format is invalid.
 *
 * @throws Never — returns `null` on any format violation rather than throwing.
 */
function parseRoomName(room: string): ParsedRoom | null {
  const parts = room.split(':');
  if (parts.length !== 3) return null;
  const [storageName, entityId, channelName] = parts;
  if (!storageName || !entityId || !channelName) return null;
  return { storageName, entityId, channelName };
}

// ---------------------------------------------------------------------------
// Subscribe guard builder
// ---------------------------------------------------------------------------

/**
 * Build a subscribe guard from a combined map of storageName → EntityChannelConfig.
 *
 * The returned guard function is passed to `WsConfig.endpoints[name].onRoomSubscribe`.
 * When called, it parses the room name into `{storageName, entityId, channelName}`,
 * locates the matching channel declaration, and runs auth → permission →
 * middleware checks in order, returning `true` only when every gate passes.
 *
 * Guard execution order per subscribe:
 * 1. Parse room name → `{ storageName, entityId, channelName }` — deny if malformed.
 * 2. Look up `channelConfigs.get(storageName)` — deny if not registered.
 * 3. Look up `channels[channelName]` — deny if not declared.
 * 4. If `auth === 'userAuth'` or `'bearer'`: call `deps.getActor(ws)` — deny if `null`
 *    or `actor.kind === 'anonymous'`.
 * 5. If `permission` present: call `deps.checkPermission(actor, ...)` — deny if `false`.
 *    If `permission.ownerField` is set: load entity via `deps.getEntity()` and
 *    compare `entity[ownerField]` to `actor.id` — deny if mismatch.
 * 6. For each name in `declaration.middleware`: call `deps.middleware[name]` — deny if `false`.
 * 7. Return `true`.
 *
 * @param channelConfigs - Map of entity `_storageName` → `EntityChannelConfig`.
 *   Typically built from the plugin's entity entries by iterating `entry.channels`.
 * @param deps - Runtime dependencies for identity resolution, permission checking,
 *   named middleware handlers, and optional entity loading.
 * @returns An async guard function `(ws, room) => Promise<boolean>` suitable for
 *   use as `WsConfig.endpoints[name].onRoomSubscribe`.
 *
 * @example
 * ```ts
 * import { buildSubscribeGuard } from '@lastshotlabs/slingshot-entity';
 *
 * // Typically called via EntityPlugin.buildSubscribeGuard():
 * const guard = chatPlugin.buildSubscribeGuard({
 *   getActor: (ws) => (ws as MyWs).data?.actor ?? null,
 *   checkPermission: (actor, perm) =>
 *     permEvaluator.can(
 *       { subjectId: actor.id ?? '', subjectType: actor.kind === 'user' ? 'user' : 'service' },
 *       perm,
 *     ),
 *   middleware: {},
 *   getEntity: (storageName, id) => db.get(storageName, id),
 * });
 *
 * // Wire into app config:
 * ws: { endpoints: { entities: { onRoomSubscribe: guard } } }
 * ```
 */
export function buildSubscribeGuard(
  channelConfigs: Map<string, EntityChannelConfig>,
  deps: ChannelConfigDeps,
): (ws: unknown, room: string) => Promise<boolean> {
  return async (ws: unknown, room: string): Promise<boolean> => {
    const parsed = parseRoomName(room);
    if (!parsed) return false;

    const { storageName, entityId, channelName } = parsed;

    // Find the channel config for this entity's storage name
    const entityChannelConfig = channelConfigs.get(storageName);
    if (!entityChannelConfig) return false;

    const declaration = (
      entityChannelConfig.channels as Record<string, EntityChannelDeclaration | undefined>
    )[channelName];
    if (!declaration) return false;

    const context = { storageName, entityId, channelName };

    // Auth check
    const auth = declaration.auth ?? 'none';
    let actor: Actor | null = null;
    if (auth === 'userAuth' || auth === 'bearer') {
      actor = deps.getActor(ws);
      if (!actor || actor.kind === 'anonymous' || !actor.id) return false;
    }

    // Permission check
    if (declaration.permission) {
      if (!actor) {
        actor = deps.getActor(ws);
        if (!actor || actor.kind === 'anonymous' || !actor.id) return false;
      }
      let allowed: boolean;
      try {
        allowed = await deps.checkPermission(
          actor,
          declaration.permission.requires,
          declaration.permission.scope,
        );
      } catch {
        return false;
      }
      if (!allowed && declaration.permission.or) {
        try {
          allowed = await deps.checkPermission(
            actor,
            declaration.permission.or,
            declaration.permission.scope,
          );
        } catch {
          return false;
        }
      }
      if (!allowed) return false;

      // Ownership check — entity[ownerField] must match the subscriber's actor id.
      // Requires deps.getEntity to resolve the entity by parsed room id.
      if (declaration.permission.ownerField) {
        if (!deps.getEntity) return false;
        let entity: Record<string, unknown> | null;
        try {
          entity = await deps.getEntity(storageName, entityId);
        } catch {
          return false;
        }
        if (!entity) return false;
        if (entity[declaration.permission.ownerField] !== actor.id) return false;
      }
    }

    // Named middleware chain
    if (declaration.middleware) {
      for (const name of declaration.middleware) {
        const handler = (deps.middleware as Record<string, ChannelMiddlewareHandler | undefined>)[
          name
        ];
        if (!handler) return false;
        let result: boolean;
        try {
          result = await handler(ws, context);
        } catch {
          return false;
        }
        if (!result) return false;
      }
    }

    return true;
  };
}

// ---------------------------------------------------------------------------
// Event forwarding
// ---------------------------------------------------------------------------

/**
 * Typed facade for dynamic event subscription on the bus.
 *
 * `SlingshotEventBus` has a statically-typed `on`/`off` interface keyed against
 * `SlingshotEventMap`. Channel event names are config-driven strings not present
 * in the static map, so we widen the type locally here rather than augmenting
 * the global interface for all consumers. The cast in `wireChannelForwarding`
 * is safe because at runtime any string key is valid on the underlying
 * `InProcessAdapter`.
 *
 * @remarks
 * This is a deliberate, contained use of local type widening per rule 14
 * (no module augmentation pollution). Do not promote this to a global type.
 */
type DynamicEventBus = {
  on(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
  off(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
};

/**
 * Wire event forwarding for a single entity's channel config.
 *
 * For each channel declaration that has `forward.events`, subscribes to every
 * listed bus event and, on receipt, constructs the room name
 * `{storageName}:{entityId}:{channelName}` and calls `publishFn` to broadcast
 * the payload to all connected room subscribers.
 *
 * The `entityId` is extracted from the event payload using
 * `declaration.forward.idField ?? entity._pkField`.
 *
 * `publishFn` is injected rather than imported directly because the framework's
 * `publish()` helper lives in `src/framework/lib/ws.ts`, which is not accessible
 * to packages. The caller (`createEntityPlugin` `setupPost`) provides it.
 *
 * @param channelConfig - The entity's channel configuration, declaring which
 *   events to forward to which channels.
 * @param entity - The resolved entity config, used for `_storageName` and
 *   `_pkField` when `forward.idField` is not set.
 * @param getWsState - Lazy accessor for the framework's `WsState` object.
 *   Resolved at emit time so forwarding still works when plugin setup runs
 *   before WS runtime state exists.
 * @param bus - The app-scoped event bus to subscribe to.
 * @param endpoint - The WS endpoint name (e.g. `'entities'`) used when routing
 *   room publishes.
 * @param publishFn - The framework's publish function. Called with
 *   `(wsState, endpoint, room, payload)` for each forwarded event.
 * @returns An unsubscribe function — call it to remove all bus listeners
 *   registered by this call (e.g. during plugin teardown).
 *
 * @example
 * ```ts
 * import { wireChannelForwarding } from '@lastshotlabs/slingshot-entity';
 *
 * const unsub = wireChannelForwarding(
 *   entry.channels,
 *   entry.config,
 *   () => getContext(app).ws,
 *   bus,
 *   'entities',
 *   publish,
 * );
 * // Later, during teardown:
 * unsub();
 * ```
 */
export function wireChannelForwarding(
  channelConfig: EntityChannelConfig,
  entity: ResolvedEntityConfig,
  getWsState: () => WsState | null,
  bus: SlingshotEventBus,
  endpoint: string,
  publishFn: WsPublishFn<WsState>,
): () => void {
  const dynamicBus = bus as unknown as DynamicEventBus;
  const cleanups: Array<() => void> = [];

  for (const [channelName, declaration] of Object.entries(channelConfig.channels)) {
    if (!declaration.forward?.events.length) continue;

    const idField = declaration.forward.idField ?? entity._pkField;

    for (const eventKey of declaration.forward.events) {
      const handler = (payload: Record<string, unknown>): void => {
        const wsState = getWsState();
        if (!wsState) return;
        const entityId = payload[idField];
        if (typeof entityId !== 'string') return;

        const room = `${entity._storageName}:${entityId}:${channelName}`;
        publishFn(wsState, endpoint, room, payload);
      };

      dynamicBus.on(eventKey, handler);
      cleanups.push(() => dynamicBus.off(eventKey, handler));
    }
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };
}

// ---------------------------------------------------------------------------
// Receive handler builder
// ---------------------------------------------------------------------------

/**
 * Build the receive handler map for a single entity's channel config.
 *
 * For each channel declaration with `receive.events`, adds one entry per event type to
 * the returned map. Each handler:
 * 1. Validates `payload.room` is a non-empty string with a valid room name pattern.
 * 2. Parses room → `{storageName}:{entityId}:{channelName}`.
 * 3. Confirms `storageName` matches the entity and `channelName` has a `receive` config.
 * 4. Confirms the event type is in `receive.events` whitelist (defense in depth).
 * 5. Confirms the sender is subscribed (via `ws.data.rooms`) — prevents relay to
 *    rooms the sender has not joined.
 * 6. If `toRoom` (default `true`), calls `publishFn` to broadcast to the room,
 *    optionally excluding the sender (`excludeSender`, default `true`).
 *
 * Returns a `Record<string, ChannelIncomingEventDeclaration>` for merging into the WS
 * endpoint's `incoming` config via `buildReceiveIncoming()`.
 *
 * When the same `eventType` appears in multiple channel declarations the last one wins
 * (last-wins merge semantics, consistent with `buildReceiveIncoming`).
 *
 * @param channelConfig - The entity's channel configuration.
 * @param entity - The resolved entity config (used for `_storageName`).
 * @param getWsState - Lazy accessor for `WsState`. Called at message time — must be
 *   non-null when messages arrive or forwarding is silently skipped.
 * @param publishFn - The framework's publish function.
 * @param endpoint - WS endpoint name (e.g. `'community'`).
 *
 * @example
 * ```ts
 * import { buildEntityReceiveHandlers } from '@lastshotlabs/slingshot-entity';
 *
 * const handlers = buildEntityReceiveHandlers(
 *   entry.channels,
 *   entry.config,
 *   () => getContext(app).ws,
 *   publish,
 *   'community',
 * );
 * // Merge into WS endpoint:
 * // incoming: { ...handlers }
 * ```
 */
export function buildEntityReceiveHandlers(
  channelConfig: EntityChannelConfig,
  entity: ResolvedEntityConfig,
  getWsState: () => WsState | null,
  publishFn: WsPublishFn<WsState>,
  endpoint: string,
): Record<string, ChannelIncomingEventDeclaration> {
  const handlers: Record<string, ChannelIncomingEventDeclaration> = {};

  for (const [channelName, declaration] of Object.entries(channelConfig.channels)) {
    if (!declaration.receive?.events.length) continue;

    const toRoom = declaration.receive.toRoom ?? true;
    const excludeSender = declaration.receive.excludeSender ?? true;
    const whitelistedEvents = declaration.receive.events;

    for (const eventType of whitelistedEvents) {
      // Last-wins if the same eventType appears in multiple channels.
      handlers[eventType] = {
        auth: 'userAuth',
        handler: (rawWs: unknown, payload: unknown): void => {
          // Cast justified: framework always passes ServerWebSocket<SocketData>.
          // slingshot-entity cannot import Bun types directly — cast via unknown.
          const ws = rawWs as { data: { id: string; rooms: Set<string> } };

          if (
            typeof payload !== 'object' ||
            payload === null ||
            typeof (payload as Record<string, unknown>).room !== 'string'
          ) {
            return;
          }

          const room = (payload as Record<string, unknown>).room as string;
          if (!isValidRoomName(room)) return;

          // Validate sender is subscribed — prevents relaying to unsubscribed rooms.
          if (!ws.data.rooms.has(room)) return;

          // Parse room: {storageName}:{entityId}:{channelName}
          const parsed = parseRoomName(room);
          if (!parsed) return;
          if (parsed.storageName !== entity._storageName) return;
          if (parsed.channelName !== channelName) return;

          if (toRoom) {
            const wsState = getWsState();
            if (!wsState) return;
            const exclude = excludeSender ? new Set([ws.data.id]) : undefined;
            publishFn(
              wsState,
              endpoint,
              room,
              { event: eventType, room, ...(payload as Record<string, unknown>) },
              exclude !== undefined ? { exclude } : undefined,
            );
          }
        },
      };
    }
  }

  return handlers;
}
