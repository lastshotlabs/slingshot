// packages/slingshot-chat/src/testing/index.ts
/**
 * Testing utilities for @lastshotlabs/slingshot-chat.
 *
 * Import from `@lastshotlabs/slingshot-chat/testing` — not from the main export.
 *
 * @example
 * ```ts
 * import { createChatTestApp, seedRoom, seedMessage } from '@lastshotlabs/slingshot-chat/testing'
 *
 * const { app, state } = await createChatTestApp()
 * const room = await seedRoom(state, { type: 'group', name: 'Test Room' })
 * const res = await app.request('/chat/rooms', { headers: { 'x-user-id': 'user-1' } })
 * ```
 */
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type {
  AppEnv,
  CoreRegistrar,
  EntityRegistry,
  NotificationsPeerState,
  PermissionEvaluator,
  PermissionsState,
  ResolvedEntityConfig,
  SlingshotEventBus,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  NOTIFICATIONS_PLUGIN_STATE_KEY,
  PERMISSIONS_STATE_KEY,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  deepFreeze,
  resolveRepo,
} from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { createNotificationsTestAdapters } from '@lastshotlabs/slingshot-notifications/testing';
import { createPermissionRegistry } from '@lastshotlabs/slingshot-permissions';
import { createMemoryPermissionsAdapter } from '@lastshotlabs/slingshot-permissions/testing';
import {
  blockFactories,
  favoriteRoomFactories,
  memberFactories,
  messageFactories,
  pinFactories,
  reactionFactories,
  receiptFactories,
  roomFactories,
} from '../entities/factories';
import { uuid } from '../lib/utils';
import { createChatPlugin } from '../plugin';
import { CHAT_PLUGIN_STATE_KEY } from '../state';
import type {
  ChatPluginConfig,
  ChatPluginState,
  CreateMemberInput,
  CreateMessageInput,
  CreateRoomInput,
  Message,
  MessageAdapter,
  Room,
  RoomMember,
  RoomMemberAdapter,
} from '../types';

// Minimal infra stub for memory backend — no real connections needed
// Memory adapters don't access infra — stub is safe
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const memoryInfra = {} as StoreInfra;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extract the simple action from a `requires` permission string.
 * `'chat:room.write'` → `'write'`, `'chat:message.edit'` → `'edit'`.
 * @internal
 */
function parseAction(requires: string): string {
  const lastDot = requires.lastIndexOf('.');
  return lastDot >= 0 ? requires.slice(lastDot + 1) : requires;
}

/**
 * Creates a lazy member-role evaluator for testing.
 *
 * Initially permissive (returns `true` for everything). Once `wire()` is called
 * with resolved adapters, uses member role + message authorship to evaluate
 * permissions — no RBAC grants required.
 *
 * Unscoped checks (e.g., room creation with no `scope.resourceId`) always
 * return `true` for authenticated users.
 *
 * @internal
 */
function createLazyMemberRoleEvaluator(): {
  evaluator: PermissionEvaluator;
  wire: (members: RoomMemberAdapter, messages: MessageAdapter) => void;
} {
  let membersRef: RoomMemberAdapter | undefined;
  let messagesRef: MessageAdapter | undefined;

  const roomRoleActions: Record<string, string[]> = {
    owner: ['*'],
    admin: ['read', 'write', 'invite', 'kick', 'delete', 'manage'],
    member: ['read', 'write'],
  };
  const messageRoleActions: Record<string, string[]> = {
    owner: ['*'],
    author: ['read', 'write', 'edit', 'delete'],
    member: ['read', 'write'],
  };

  function matches(map: Record<string, string[]>, role: string, action: string): boolean {
    const actions = map[role] ?? [];
    return actions.includes('*') || actions.includes(action);
  }

  const evaluator: PermissionEvaluator = {
    async can(subject, rawAction, scope): Promise<boolean> {
      const action = parseAction(rawAction);
      // Unscoped = global action (e.g., room creation) — always allow for authenticated users
      if (!scope || !scope.resourceType || !scope.resourceId) return true;
      // Not yet wired = allow (during bootstrap)
      if (!membersRef || !messagesRef) return true;

      const { resourceType, resourceId } = scope;

      if (resourceType === 'chat:room') {
        const member = await membersRef.findMember({
          roomId: resourceId,
          userId: subject.subjectId,
        });
        if (!member) return false;
        return matches(roomRoleActions, member.role, action);
      }

      if (resourceType === 'chat:message') {
        const message = await messagesRef.getById(resourceId);
        if (!message) return false;
        if (message.authorId === subject.subjectId) {
          if (matches(messageRoleActions, 'author', action)) return true;
        }
        const member = await membersRef.findMember({
          roomId: message.roomId,
          userId: subject.subjectId,
        });
        if (!member) return false;
        if (member.role === 'admin' && matches(roomRoleActions, 'admin', action)) return true;
        return matches(messageRoleActions, member.role, action);
      }

      return false;
    },
  };

  return {
    evaluator,
    wire(members, messages) {
      membersRef = members;
      messagesRef = messages;
    },
  };
}

/**
 * Create a minimal `SlingshotFrameworkConfig` for test bootstrapping.
 *
 * The entity plugin reads `resolvedStores.authStore` for the store type and
 * `storeInfra` for adapter resolution. Everything else is stubbed.
 *
 * @internal
 */
function createTestFrameworkConfig() {
  Reflect.set(memoryInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry: EntityRegistry = {
    register(c: ResolvedEntityConfig) {
      registeredEntities.push(c);
    },
    getAll() {
      return registeredEntities;
    },
    filter(predicate: (e: ResolvedEntityConfig) => boolean) {
      return registeredEntities.filter(predicate);
    },
  };

  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  } as unknown as CoreRegistrar;

  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false as const,
    storeInfra: memoryInfra,
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}

/**
 * Build the permissions state (evaluator, registry, adapter) used by the
 * test app. The evaluator is a lazy member-role evaluator that must be
 * wired after plugin lifecycle resolves the adapters.
 *
 * @internal
 */
function createTestPermsState() {
  const permAdapter = createMemoryPermissionsAdapter();
  const registry = createPermissionRegistry();
  registry.register({
    resourceType: 'chat:room',
    actions: ['read', 'write', 'invite', 'kick', 'delete', 'manage'],
    roles: {
      owner: ['*'],
      admin: ['read', 'write', 'invite', 'kick', 'delete', 'manage'],
      member: ['read', 'write'],
    },
  });
  registry.register({
    resourceType: 'chat:message',
    actions: ['read', 'write', 'edit', 'delete'],
    roles: {
      owner: ['*'],
      author: ['read', 'write', 'edit', 'delete'],
      member: ['read', 'write'],
    },
  });

  const { evaluator, wire } = createLazyMemberRoleEvaluator();
  const permsState: PermissionsState = { evaluator, registry, adapter: permAdapter };
  return { permsState, wire, permAdapter };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a fully wired in-memory `ChatPluginState` for use in tests.
 *
 * All repos are memory-backed. No external dependencies.
 * The `evaluator` is a member-role evaluator — tests can seed member rows
 * directly without needing to create RBAC grants.
 *
 * Use this for unit tests that need direct adapter access without HTTP routes.
 * For integration tests with routes, use {@link createChatTestApp} instead.
 *
 * @param configOverrides - Optional partial config to override defaults.
 * @returns A `ChatPluginState` ready for test use.
 *
 * @example
 * ```ts
 * const state = createMemoryChatState()
 * expect(state.rooms).toBeDefined()
 * ```
 */
export function createMemoryChatState(
  configOverrides: Partial<ChatPluginConfig> = {},
): ChatPluginState {
  const chatConfig: Readonly<ChatPluginConfig> = deepFreeze({
    storeType: 'memory',
    mountPath: '/chat',
    pageSize: 50,
    enablePresence: true,
    permissions: {},
    ...configOverrides,
  });

  const rooms = resolveRepo(roomFactories, 'memory', memoryInfra);
  const members = resolveRepo(memberFactories, 'memory', memoryInfra);
  const messages = resolveRepo(messageFactories, 'memory', memoryInfra);
  const receipts = resolveRepo(receiptFactories, 'memory', memoryInfra);
  const reactions = resolveRepo(reactionFactories, 'memory', memoryInfra);
  const pins = resolveRepo(pinFactories, 'memory', memoryInfra);
  const blocks = resolveRepo(blockFactories, 'memory', memoryInfra);
  const favorites = resolveRepo(favoriteRoomFactories, 'memory', memoryInfra);

  // Cast resolveRepo() results to hand-written adapter interfaces.
  // Opaque boundary between entity framework generics and our concrete API.
  const typedRooms = rooms as ChatPluginState['rooms'];
  const typedMembers = members as ChatPluginState['members'];
  const typedMessages = messages as unknown as ChatPluginState['messages'];
  const typedReceipts = receipts as ChatPluginState['receipts'];
  const typedReactions = reactions as ChatPluginState['reactions'];
  const typedPins = pins as ChatPluginState['pins'];
  const typedBlocks = blocks as ChatPluginState['blocks'];
  const typedFavorites = favorites as ChatPluginState['favorites'];

  const { evaluator } = createLazyMemberRoleEvaluator();

  return {
    rooms: typedRooms,
    members: typedMembers,
    messages: typedMessages,
    receipts: typedReceipts,
    reactions: typedReactions,
    pins: typedPins,
    blocks: typedBlocks,
    favorites: typedFavorites,
    config: chatConfig,
    evaluator,
  };
}

/**
 * Create a Hono test app with all chat routes mounted via the entity-driven
 * plugin. Returns the app for use with `app.request(...)`.
 *
 * The plugin bootstraps exactly as it does in production — entity routes are
 * generated by `createEntityPlugin`, not hand-written. The evaluator derives
 * permissions from seeded member rows, so tests don't need RBAC grants.
 *
 * @param configOverrides - Optional overrides for the chat plugin config.
 * @returns A configured Hono app and the plugin's `ChatPluginState`.
 *
 * @example
 * ```ts
 * const { app, state } = await createChatTestApp()
 * const room = await seedRoom(state)
 * await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' })
 * const res = await app.request('/chat/rooms/' + room.id, {
 *   headers: { 'x-user-id': 'user-1' },
 * })
 * expect(res.status).toBe(200)
 * ```
 */
export async function createChatTestApp(
  configOverrides: Partial<ChatPluginConfig> = {},
  options?: {
    /**
     * Additional entries to inject into `pluginState` before the plugin lifecycle runs.
     * Use this to mock optional peer plugins (e.g. `slingshot-embeds`, `slingshot-push`).
     */
    peersPluginState?: Map<string, unknown>;
  },
): Promise<{
  app: Hono<AppEnv>;
  state: ChatPluginState;
  notifications: ReturnType<typeof createNotificationsTestAdapters>['notifications'];
  /** The shared event bus. Call `bus.drain()` to flush async event handlers in tests. */
  bus: InProcessAdapter;
}> {
  const { permsState, wire } = createTestPermsState();
  const notificationState = createNotificationsTestAdapters();

  const plugin = createChatPlugin({
    storeType: 'memory',
    mountPath: '/chat',
    pageSize: 50,
    enablePresence: false,
    permissions: {},
    ...configOverrides,
  });

  const app = new Hono<AppEnv>();
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  const frameworkConfig = createTestFrameworkConfig();

  // Attach minimal SlingshotContext so getContext(app) works in plugin lifecycle
  const pluginState = new Map<string, unknown>();
  // Inject optional peer plugin state before the plugin lifecycle so `setupPost`
  // closures (e.g. slingshot-embeds embed listener) see the mocked peers.
  if (options?.peersPluginState) {
    for (const [key, value] of options.peersPluginState) {
      pluginState.set(key, value);
    }
  }
  pluginState.set(PERMISSIONS_STATE_KEY, permsState);
  pluginState.set(NOTIFICATIONS_PLUGIN_STATE_KEY, {
    config: deepFreeze({
      mountPath: '/notifications',
      sseEnabled: true,
      ssePath: '/notifications/sse',
      dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 500 },
      rateLimit: {
        perSourcePerUserPerWindow: 100,
        windowMs: 3_600_000,
        backend: 'memory',
      },
      defaultPreferences: {
        pushEnabled: true,
        emailEnabled: true,
        inAppEnabled: true,
      },
    }),
    notifications: notificationState.notifications,
    preferences: notificationState.preferences,
    dispatcher: {
      start() {},
      stop() {},
      tick() {
        return Promise.resolve(0);
      },
    },
    createBuilder: ({ source }: { source: string }) => notificationState.createBuilder(source),
    registerDeliveryAdapter() {},
  } satisfies NotificationsPeerState & {
    config: unknown;
    notifications: unknown;
    preferences: unknown;
    dispatcher: unknown;
  });

  attachContext(app, {
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
    events,
  } as unknown as Parameters<typeof attachContext>[1]);

  // Per-request slingshotCtx for entity route auth (applyRouteConfig reads routeAuth)
  const routeAuth = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-user-id') ?? c.req.header('x-test-user');
      if (!uid) return c.json({ error: 'Unauthorized' }, 401);
      (c as typeof c & { set(key: string, value: unknown): void }).set(
        'actor',
        Object.freeze({
          id: uid,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      await next();
    }) as MiddlewareHandler,
    requireRole: () => (async (_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
    // Set actor from test headers for encryption stub routes.
    // Entity routes set it via routeAuth.userAuth.
    const uid = c.req.header('x-user-id') ?? c.req.header('x-test-user');
    if (uid) {
      const setter = c as typeof c & { set(key: string, value: unknown): void };
      setter.set(
        'actor',
        Object.freeze({
          id: uid,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
    }
    (c as typeof c & { set(key: string, value: unknown): void }).set('slingshotCtx', {
      routeAuth,
      events,
    });
    await next();
  });

  // Run full plugin lifecycle
  await plugin.setupMiddleware?.({
    app,
    config: frameworkConfig as never,
    bus: bus as SlingshotEventBus,
    events,
  });
  await plugin.setupRoutes?.({
    app,
    config: frameworkConfig as never,
    bus: bus as SlingshotEventBus,
    events,
  });
  await plugin.setupPost?.({
    app,
    config: frameworkConfig as never,
    bus: bus as SlingshotEventBus,
    events,
  });

  // Read the plugin's resolved state
  const state = pluginState.get(CHAT_PLUGIN_STATE_KEY) as ChatPluginState | undefined;
  if (!state) throw new Error('Chat plugin did not register state — lifecycle failed');

  // Wire the lazy evaluator to the actual adapters
  wire(state.members, state.messages);

  return { app, state, notifications: notificationState.notifications, bus };
}

/**
 * Seed a room in the test state.
 *
 * @param state - A `ChatPluginState` from `createChatTestApp()` or `createMemoryChatState()`.
 * @param input - Partial room create input. Defaults to `{ name: 'Test Room', type: 'group' }`.
 * @returns The created `Room`.
 */
export async function seedRoom(
  state: ChatPluginState,
  input: Partial<CreateRoomInput & { id?: string }> = {},
): Promise<Room> {
  return state.rooms.create({
    name: 'Test Room',
    type: 'group',
    id: uuid(),
    ...input,
  });
}

/**
 * Seed a room member in the test state.
 *
 * @param state - A `ChatPluginState` from `createChatTestApp()` or `createMemoryChatState()`.
 * @param input - Member create input. `roomId` and `userId` are required.
 * @returns The created `RoomMember`.
 */
export async function seedMember(
  state: ChatPluginState,
  input: CreateMemberInput,
): Promise<RoomMember> {
  return state.members.create(input);
}

/**
 * Seed a message in the test state.
 *
 * @param state - A `ChatPluginState` from `createChatTestApp()` or `createMemoryChatState()`.
 * @param input - Partial message create input. `roomId` and `body` are required.
 *   Accepts all content-model fields (`format`, `mentions`, `attachments`, etc.).
 * @returns The created `Message`.
 */
export async function seedMessage(
  state: ChatPluginState,
  input: Partial<CreateMessageInput> & { roomId: string; body: string },
): Promise<Message> {
  return state.messages.create({ id: uuid(), type: 'text', format: 'markdown', ...input });
}
