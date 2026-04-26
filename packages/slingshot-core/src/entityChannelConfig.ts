// ============================================================================
// Entity Channel Configuration — declarative per-entity WebSocket channel wiring.
//
// Consumed by applyChannelConfig() at runtime to wire auth, permissions,
// and named middleware onto WebSocket channel subscriptions, plus event
// forwarding from the bus to channel subscribers.
// ============================================================================
import type { Actor } from './identity';

/**
 * Authentication strategy enforced at WebSocket channel subscribe time.
 *
 * - `'userAuth'` — requires a valid session (resolved by `RequestActorResolver`)
 * - `'bearer'`   — requires a valid bearer token
 * - `'none'`     — no auth check; any client may subscribe
 *
 * @remarks
 * This mirrors {@link RouteAuthConfig} from `entityRouteConfig.ts` but applies to the
 * WebSocket subscribe handshake rather than HTTP route handlers. The auth check runs
 * once when the client sends the initial subscribe message; it is not re-evaluated on
 * every incoming WebSocket frame.
 *
 * @example
 * ```ts
 * const channel: EntityChannelDeclaration = {
 *   auth: 'userAuth', // only authenticated users may subscribe
 * };
 * ```
 */
export type ChannelAuthConfig = 'userAuth' | 'bearer' | 'none';

// --- Permissions ---
/**
 * Permission check applied when a client subscribes to a WebSocket channel.
 * Mirrors {@link RoutePermissionConfig} from `entityRouteConfig.ts` but for the WS
 * subscription layer. The framework evaluates the permission grant before accepting
 * the subscription — clients that fail the check are rejected immediately.
 *
 * @remarks
 * `ownerField` enables entity-ownership checks: the framework reads the value of the
 * named entity field and compares it to the authenticated subscriber's user ID.
 * Set `or` to allow an alternative action (e.g., an admin override) to satisfy the
 * permission in addition to `requires`.
 *
 * @example
 * ```ts
 * const permission: ChannelPermissionConfig = {
 *   requires: 'post:read',
 *   ownerField: 'authorId', // also allows the post author regardless of grants
 *   or: 'post:moderate',    // moderators can also subscribe
 * };
 * ```
 */
export interface ChannelPermissionConfig {
  /** The permission action the subscriber must hold (e.g. `'post:read'`). */
  requires: string;

  /**
   * Entity field whose value is compared to the authenticated subscriber's user ID.
   *
   * @remarks
   * When set, the framework fetches the entity record for the channel's entity ID and reads
   * `entityRecord[ownerField]`. If that value equals the subscriber's resolved user ID, the
   * subscription is accepted regardless of whether the subscriber holds the `requires` grant.
   * This is a bypass check (owner OR permission), not an AND condition.
   *
   * `ownerField` must be a `'string'` field on the entity. Referencing a field of any other
   * type is a startup-time configuration error. If the entity record is not found (e.g. the
   * entity has been deleted), the ownership check returns `false` and the subscriber must
   * satisfy `requires` instead.
   *
   * Leave `ownerField` unset for channels where ownership semantics do not apply (e.g. a
   * public broadcast channel with only role-based access).
   */
  ownerField?: string;

  /**
   * An alternative permission action that also grants subscribe access.
   *
   * @remarks
   * The framework evaluates subscribe access as: `requires` OR `or`. Both are independently
   * sufficient — holding either grants access. There is no AND semantics between `requires`
   * and `or`; they are alternatives, not requirements that must both be satisfied.
   *
   * A common use-case is pairing a resource-scoped action with an admin override:
   * `requires: 'post:read'` + `or: 'post:moderate'` means subscribers need either
   * read access on posts or moderation access (which typically includes read).
   */
  or?: string;

  /**
   * Additional scope key/value pairs used when resolving the permission grant.
   *
   * @remarks
   * Scope values are matched against the current subscriber's grant context (e.g. tenant,
   * organisation). Values can be static strings or `:param`-style references that are
   * interpolated from the channel room name at subscribe time (e.g. `':tenantId'` is
   * replaced with the `tenantId` segment from the room string).
   *
   * For example, `scope: { tenantId: ':tenantId' }` restricts the permission check to the
   * tenant implied by the channel room, preventing cross-tenant subscription escalation.
   */
  scope?: Record<string, string>;
}

// --- Event Forwarding ---
/**
 * Bus events to forward to subscribers of a WebSocket channel.
 *
 * When one of the listed bus events fires, the framework extracts the entity ID from
 * the event payload using `idField` (defaulting to the entity's primary key field name)
 * and delivers the payload to all clients subscribed to the matching room
 * `{storageName}:{entityId}:{channelName}`.
 *
 * @remarks
 * Only events whose registry definitions allow external delivery are eligible
 * to be forwarded to WebSocket subscribers. Attempting to forward an event
 * without client-safe exposure is a configuration error caught at startup.
 * List at least one event in `events`; the schema enforces a minimum length of 1.
 *
 * @example
 * ```ts
 * const forward: ChannelForwardConfig = {
 *   events: ['post:activity.created', 'post:activity.updated'],
 *   idField: 'postId', // extract entity ID from payload.postId
 * };
 * ```
 */
export interface ChannelForwardConfig {
  /**
   * Bus event keys to forward to channel subscribers. Must contain at least one entry.
   *
   * @remarks
   * Only events whose registry definitions allow client-safe exposure are
   * eligible for forwarding. The framework validates all declared event keys
   * at startup — an unregistered or forbidden-namespace event key is a
   * startup-time error.
   *
   * Valid event key format is `namespace:storageName.action`, e.g. `'post:post.created'`.
   * Forbidden namespaces (`security.*`, `auth:*`, `community:delivery.*`, `push:*`, `app:*`)
   * are never externally deliverable and cannot appear here.
   */
  events: string[];

  /**
   * Field name used to extract the entity ID from the event payload.
   *
   * @remarks
   * Defaults to the entity's primary key field name when omitted. The framework reads
   * `eventPayload[idField]` and uses that value to construct the room key
   * `{storageName}:{entityId}:{channelName}`, then delivers the payload to all sockets
   * subscribed to that room.
   *
   * Use a non-default `idField` when the event payload carries the relevant ID under a
   * different key — for example, a `post:activity.created` event may carry the post ID as
   * `payload.postId` rather than `payload.id`. In that case set `idField: 'postId'`.
   *
   * The field must be a `'string'` or `'integer'` type on the entity. If the extracted
   * value is `undefined` at runtime, the event is dropped (no delivery) without error.
   */
  idField?: string;
}

// --- Client-initiated event relay ---
/**
 * Whitelisted client-sent events that the server will relay to channel subscribers.
 *
 * When a client sends `{ action: 'event', type: 'document.typing', payload: { room: '...' } }`,
 * the framework validates that the event type is in the channel's `receive.events` whitelist, that
 * the sender is subscribed to the declared room, and then broadcasts the payload to all other
 * subscribers of that room.
 *
 * Use `receive` for lightweight ephemeral signals (typing indicators, cursor positions) that must
 * be relayed in real time without server-side processing.
 *
 * @remarks
 * The channel's `auth` config is not re-checked at receive time — auth is enforced at subscribe
 * time only. However, room membership (the sender must be subscribed to the room) is always
 * checked before relay. Clients that send events for rooms they are not subscribed to are silently
 * dropped.
 *
 * The event type whitelist (`events`) applies at the channel level, not the endpoint level.
 * Declare each event type in exactly one channel's `receive.events` — duplicates across channels
 * result in only one handler being registered (last-wins in the `buildReceiveIncoming` merge).
 *
 * @example
 * ```ts
 * const receive: ChannelReceiveConfig = {
 *   events: ['document.typing', 'thread.typing'],
 *   toRoom: true,
 *   excludeSender: true,
 * };
 * ```
 */
export interface ChannelReceiveConfig {
  /**
   * Whitelisted event type strings the client may send to this channel.
   * Must contain at least one entry.
   * Event types not in this list are silently dropped.
   */
  events: string[];
  /**
   * When `true` (default), received events are broadcast to all room subscribers.
   */
  toRoom?: boolean;
  /**
   * When `true` (default), the sender socket is excluded from the room broadcast.
   * The sender never sees their own typing indicator reflected back.
   * Only applies when `toRoom: true`.
   */
  excludeSender?: boolean;
}

/**
 * A single named incoming WebSocket event handler declaration.
 *
 * Returned by `buildReceiveIncoming()` and merged into `WsEndpointConfig.incoming`.
 * The framework's `wsDispatch.handleIncomingEvent()` dispatches `{ action: 'event', type }`
 * messages to the matching handler.
 *
 * @remarks
 * The `handler` signature matches `WsEventHandler` from `src/config/types/ws.ts`. The
 * `ws` parameter is opaque (`unknown`) at the slingshot-core boundary — framework code casts
 * it to `ServerWebSocket<SocketData>` at use sites.
 */
export interface ChannelIncomingEventDeclaration {
  /** Auth level required to send this event. Defaults to `'userAuth'`. */
  auth?: 'userAuth' | 'bearer' | 'none';
  /** Named middleware run before the handler, in order. */
  middleware?: string[];
  /**
   * The event handler. Called with the WebSocket connection (opaque), the raw payload,
   * and a context object containing connection identity plus room helpers.
   *
   * The context shape mirrors `WsEventContext` from `src/config/types/ws.ts`. `actor` is
   * the canonical identity (`ANONYMOUS_ACTOR` for unauthenticated sockets); `requestTenantId`
   * is the request-scoped tenant captured at upgrade and is distinct from `actor.tenantId`.
   */
  handler: (
    ws: unknown,
    payload: unknown,
    context: {
      socketId: string;
      actor: Actor;
      requestTenantId: string | null;
      endpoint: string;
      publish(room: string, data: unknown): void;
      subscribe(room: string): void;
      unsubscribe(room: string): void;
    },
  ) => unknown;
}

// --- Single Channel Declaration ---
/**
 * Configuration for a single named channel on an entity.
 *
 * Channels create WebSocket rooms with the pattern `{storageName}:{entityId}:{channelName}`.
 * Clients subscribe by sending `{ type: 'subscribe', room: '{storageName}:{entityId}:{channelName}' }`.
 * The framework evaluates `auth`, `permission`, and `middleware` in that order when a
 * subscribe message is received, then registers the client for event forwarding.
 *
 * @remarks
 * All fields are optional — an empty declaration `{}` creates a public channel with no auth,
 * no permission check, no middleware, and no forwarded events. Add only the fields you need.
 * `middleware` entries are resolved from the entity plugin config's `middleware` map at startup;
 * referencing an unknown middleware key is a startup-time error.
 *
 * @example
 * ```ts
 * const activityChannel: EntityChannelDeclaration = {
 *   auth: 'userAuth',
 *   permission: { requires: 'post:read', ownerField: 'authorId' },
 *   middleware: ['rateLimitSubscribe'],
 *   forward: { events: ['post:activity.created'], idField: 'postId' },
 *   presence: true,
 * };
 * ```
 */
export interface EntityChannelDeclaration {
  /** Auth enforced at subscribe time. Defaults to `'none'`. */
  auth?: ChannelAuthConfig;

  /** Permission check applied before allowing the subscription. */
  permission?: ChannelPermissionConfig;

  /**
   * Named middleware factories called at subscribe time, in declaration order.
   *
   * @remarks
   * Middleware names must match keys declared in the entity plugin config's `middleware` map.
   * Referencing an unknown name is a startup-time error. Middleware executes in the order
   * listed — earlier entries run first, later entries run after. Each middleware can abort
   * the subscribe flow by throwing or returning an error response; the remaining middleware
   * entries and the subscribe handler are then skipped.
   *
   * Middleware runs after `auth` and `permission` are evaluated. It cannot influence those
   * earlier checks.
   */
  middleware?: string[];

  /**
   * Bus events to fan out to subscribers on this channel.
   *
   * @remarks
   * When one of the listed events fires, the framework extracts the entity ID from the
   * event payload (using `forward.idField`, defaulting to the entity's primary key field),
   * looks up all sockets subscribed to `{storageName}:{entityId}:{channelName}`, and
   * delivers the raw event payload to each. The payload is sent as-is — no server-side
   * field filtering is applied at the forwarding layer; use `clientSafeEvents` registration
   * to ensure only safe fields are ever part of the payload.
   *
   * If no clients are subscribed to the matching room when the event fires, the event is
   * silently dropped — there is no delivery queue or retry mechanism.
   */
  forward?: ChannelForwardConfig;

  /**
   * Enable presence tracking for subscribers on this channel.
   *
   * When `true`, the WS framework broadcasts `presence_join` when a user's first
   * socket subscribes to the room, and `presence_leave` when their last socket leaves.
   *
   * **Prerequisite:** The WS endpoint this entity plugin is attached to (via
   * `EntityPluginConfig.wsEndpoint`) must have `presence: true` in the app's
   * `WsConfig.endpoints` configuration. Without it, presence events are silently
   * suppressed — `WsState.presenceEnabled` will be `false`.
   *
   * This field does not alter runtime behavior by itself — it documents intent and
   * enables a startup warning when the endpoint lacks presence support.
   */
  presence?: boolean;

  /**
   * Client-sent events that this channel will relay to room subscribers.
   *
   * Generates a `WsIncomingEventConfig` handler entry (via `buildReceiveIncoming()`) for
   * each event type in `events`. The handler validates room membership, checks the whitelist,
   * and broadcasts the payload to room subscribers.
   *
   * Wire the generated handlers into the WS endpoint's `incoming` config:
   * ```ts
   * incoming: entityPlugin.buildReceiveIncoming()
   * ```
   */
  receive?: ChannelReceiveConfig;
}

/**
 * Top-level entity channel configuration.
 *
 * Attached to an `EntityConfig` to declare named real-time channels and their
 * subscription auth, permissions, middleware, and event-forwarding rules.
 *
 * @example
 * ```ts
 * import { defineEntity, field } from '@lastshotlabs/slingshot-core';
 *
 * export const Post = defineEntity('Post', {
 *   fields: { id: field.string({ primary: true }), status: field.string() },
 *   channels: {
 *     channels: {
 *       activity: {
 *         auth: 'userAuth',
 *         forward: { events: ['post:activity.created'] },
 *       },
 *     },
 *   },
 * });
 * ```
 */
export interface EntityChannelConfig {
  /**
   * Named channel declarations.
   * Each key becomes the channel suffix in the room name: `{storageName}:{entityId}:{key}`.
   */
  channels: Record<string, EntityChannelDeclaration>;
}
