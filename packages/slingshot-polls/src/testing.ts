/**
 * Test utilities for `@lastshotlabs/slingshot-polls`.
 *
 * Exported from the `/testing` subpath — NOT from the main entry point
 * (Rule 22). Each factory creates a fresh instance — no global state, no
 * reset functions.
 *
 * @packageDocumentation
 */
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type {
  AppEnv,
  CoreRegistrar,
  EntityRegistry,
  ResolvedEntityConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  PERMISSIONS_STATE_KEY,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
} from '@lastshotlabs/slingshot-core';
import { pollFactories, pollVoteFactories } from './entities/factories';
import { createPollsPlugin } from './plugin';
import type { PollAdapter, PollVoteAdapter } from './types/adapters';
import type {
  PollRecord,
  PollVoteRecord,
  PollsPluginConfig,
  PollsPluginState,
} from './types/public';
import { POLLS_PLUGIN_STATE_KEY } from './types/public';

const memoryInfra = {} as unknown as StoreInfra;

/**
 * Create in-memory poll and poll-vote adapters for tests.
 *
 * @returns Fresh adapter instances with a `clear()` function for test isolation.
 */
export function createPollsTestAdapters(): {
  polls: PollAdapter;
  pollVotes: PollVoteAdapter;
  clear(): Promise<void>;
} {
  const polls = pollFactories.memory(memoryInfra) as unknown as PollAdapter;
  const pollVotes = pollVoteFactories.memory(memoryInfra) as unknown as PollVoteAdapter;

  return {
    polls,
    pollVotes,
    clear() {
      return Promise.all([polls.clear(), pollVotes.clear()]).then(() => undefined);
    },
  };
}

/**
 * Seed a poll with reasonable defaults.
 *
 * @param adapter - Poll adapter to insert into.
 * @param overrides - Fields to override on the default poll.
 * @returns The created poll record.
 */
export async function seedPoll(
  adapter: PollAdapter,
  overrides: Partial<PollRecord> & { options?: readonly string[] } = {},
): Promise<PollRecord> {
  return adapter.create({
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    authorId: 'user-author',
    question: 'What is your favorite color?',
    options: ['Red', 'Blue', 'Green'],
    multiSelect: false,
    anonymous: false,
    closed: false,
    ...overrides,
  });
}

/**
 * Seed a vote on a poll.
 *
 * @param adapter - PollVote adapter to insert into.
 * @param poll - The poll to vote on (used for denormalized fields).
 * @param overrides - Fields to override on the default vote.
 * @returns The created vote record.
 */
export async function seedVote(
  adapter: PollVoteAdapter,
  poll: PollRecord,
  overrides: Partial<PollVoteRecord> = {},
): Promise<PollVoteRecord> {
  return adapter.create({
    pollId: poll.id,
    userId: 'user-voter',
    optionIndex: 0,
    sourceType: poll.sourceType,
    sourceId: poll.sourceId,
    scopeId: poll.scopeId,
    ...overrides,
  });
}

// ─── Test App Factory ─────────────────────────────────────────────────────────

/**
 * Create a minimal `SlingshotFrameworkConfig` for test bootstrapping.
 * @internal
 */
function createTestFrameworkConfig() {
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
 * Create a Hono test app with all polls routes mounted via the entity-driven
 * plugin. Returns the app for use with `app.request(...)`.
 *
 * Registers an allow-all policy resolver for `test:source` so test
 * polls are accessible. Production consumers would register their own
 * resolvers for their source types.
 *
 * @param configOverrides - Optional overrides for the polls plugin config.
 * @returns A configured Hono app and the plugin's `PollsPluginState`.
 *
 * @example
 * ```ts
 * const { app, state } = await createPollsTestApp()
 * const res = await app.request('/polls/polls', {
 *   method: 'POST',
 *   headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
 *   body: JSON.stringify({ sourceType: 'test:source', sourceId: 's1', scopeId: 'sc1', question: 'Q?', options: ['A', 'B'] }),
 * })
 * expect(res.status).toBe(201)
 * ```
 */
export async function createPollsTestApp(
  configOverrides: Partial<PollsPluginConfig> = {},
): Promise<{
  app: Hono<AppEnv>;
  state: PollsPluginState;
  bus: InProcessAdapter;
}> {
  const plugin = createPollsPlugin({
    mountPath: '/polls',
    closeCheckIntervalMs: 0,
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

  // Set up allow-all permissions for testing (no slingshot-permissions dependency needed)
  pluginState.set(PERMISSIONS_STATE_KEY, {
    evaluator: {
      can() {
        return Promise.resolve(true);
      },
    },
    registry: {
      register() {},
      getAll() {
        return [];
      },
      get() {
        return undefined;
      },
    },
    adapter: null,
  });
  attachContext(app, {
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
  } as unknown as Parameters<typeof attachContext>[1]);

  // Register allow-all policy for the test source type.
  // Must happen before setupMiddleware so the policy dispatch table picks it up.
  plugin.registerSourceHandler('test:source', () => Promise.resolve({ allow: true }), 'poll');
  plugin.registerSourceHandler('test:source', () => Promise.resolve({ allow: true }), 'vote');

  // Per-request auth stub: reads x-user-id header
  const routeAuth = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-user-id') ?? c.req.header('x-test-user');
      if (!uid) return c.json({ error: 'Unauthorized' }, 401);
      const setter = c as typeof c & { set(key: string, value: unknown): void };
      setter.set('actor', { id: uid, kind: 'user', tenantId: null, sessionId: null, roles: null, claims: {} });
      setter.set('authUserId', uid);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => ((_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
    const uid = c.req.header('x-user-id') ?? c.req.header('x-test-user');
    if (uid) {
      const setter = c as typeof c & { set(key: string, value: unknown): void };
      setter.set('actor', { id: uid, kind: 'user', tenantId: null, sessionId: null, roles: null, claims: {} });
      setter.set('authUserId', uid);
    }
    const tid = c.req.header('x-tenant-id');
    if (tid) {
      (c as typeof c & { set(key: string, value: unknown): void }).set('tenantId', tid);
    }
    (c as typeof c & { set(key: string, value: unknown): void }).set('slingshotCtx', { routeAuth });
    await next();
  });

  // Run full plugin lifecycle
  const ctx = {
    app,
    config: frameworkConfig as never,
    bus: bus as unknown as import('@lastshotlabs/slingshot-core').SlingshotEventBus,
    events,
  };
  await plugin.setupMiddleware?.(ctx);
  await plugin.setupRoutes?.(ctx);
  await plugin.setupPost?.(ctx);

  const state = pluginState.get(POLLS_PLUGIN_STATE_KEY) as PollsPluginState | undefined;
  if (!state) throw new Error('Polls plugin did not register state — lifecycle failed');

  return { app, state, bus };
}
