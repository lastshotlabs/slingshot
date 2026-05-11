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
  PermissionsState,
  ResolvedEntityConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  createPluginStateMap,
  publishPluginState,
  readPluginState,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { Poll } from './entities/poll';
import { PollVote } from './entities/pollVote';
import { pollFactories, pollVoteFactories } from './entities/factories';
import { pollOperations, pollVoteOperations } from './operations/index';
import { createPollsPackage } from './plugin';
import type { PollAdapter, PollVoteAdapter } from './types/adapters';
import type {
  PollRecord,
  PollVoteRecord,
  PollsPluginConfig,
  PollsPluginState,
} from './types/public';
import { POLLS_RUNTIME_KEY } from './types/public';

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
  const plugin = createPollsPackage({
    mountPath: '/polls',
    closeCheckIntervalMs: 0,
    // Allow-all policy handlers for the canonical test sourceType. Apps that
    // want to test a different source type override these via configOverrides.
    sourceHandlers: { 'test:source': () => Promise.resolve({ allow: true }) },
    voteHandlers: { 'test:source': () => Promise.resolve({ allow: true }) },
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
  const pluginState = createPluginStateMap();

  // Set up allow-all permissions for testing (no slingshot-permissions dependency needed).
  // The cast is intentional: tests publish a partial PermissionsState that lacks the real
  // adapter, since these polls tests don't exercise the permissions adapter surface.
  publishPluginState(pluginState, 'slingshot:package:capabilities:slingshot-permissions', {
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
  } as unknown as PermissionsState);
  attachContext(app, {
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
  } as unknown as Parameters<typeof attachContext>[1]);

  // Per-request auth stub: reads x-user-id header
  const routeAuth = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-user-id') ?? c.req.header('x-test-user');
      if (!uid) return c.json({ error: 'Unauthorized' }, 401);
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
      await next();
    }) as MiddlewareHandler,
    requireRole: () => ((_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
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
    const tid = c.req.header('x-tenant-id');
    if (tid) {
      (c as typeof c & { set(key: string, value: unknown): void }).set('tenantId', tid);
    }
    (c as typeof c & { set(key: string, value: unknown): void }).set('slingshotCtx', { routeAuth });
    await next();
  });

  const ctx = {
    app,
    config: frameworkConfig as never,
    bus: bus as unknown as import('@lastshotlabs/slingshot-core').SlingshotEventBus,
    events,
  };

  // The package's `entities: [...]` declaration is processed by the framework's
  // `compilePackages()` during `createApp(...)`. This test helper bypasses
  // that path, so we mount the entity routes manually here via
  // `createEntityPlugin`, using the same `pollFactories` / `pollVoteFactories`
  // configured on the package's entity modules. The `buildAdapter` callback
  // here is what populates the package's `onAdapter`-captured refs by way of
  // the closure-owned `Poll` / `PollVote` factory bundles — both surfaces
  // share a single adapter instance per entity.
  const sharedAdapters: { poll?: BareEntityAdapter; pollVote?: BareEntityAdapter } = {};
  const entityEntries: EntityPluginEntry[] = [
    {
      config: Poll,
      operations: pollOperations.operations,
      buildAdapter: (storeType, infra) => {
        sharedAdapters.poll = pollFactories[storeType](infra) as unknown as BareEntityAdapter;
        return sharedAdapters.poll;
      },
    },
    {
      config: PollVote,
      operations: pollVoteOperations.operations,
      buildAdapter: (storeType, infra) => {
        sharedAdapters.pollVote = pollVoteFactories[storeType](
          infra,
        ) as unknown as BareEntityAdapter;
        return sharedAdapters.pollVote;
      },
    },
  ];
  const entityPlugin = createEntityPlugin({
    name: 'slingshot-polls',
    mountPath: plugin.mountPath ?? '/polls',
    entities: entityEntries,
    middleware: plugin.middleware,
  });

  // Run lifecycles in framework-equivalent order:
  //   1. package setupMiddleware  — registers policies + dataScope hooks
  //   2. entity setupMiddleware    — entity-plugin policy hooks
  //   3. entity setupRoutes        — mounts entity CRUD + named-op routes
  //      (also calls our buildAdapter callbacks; shared adapters are then
  //       reused below to seed the package's vote-guard ref)
  //   4. package setupRoutes       — mounts the /results route on top
  //   5. entity setupPost / package setupPost — final wiring
  await plugin.setupMiddleware?.(ctx);
  await entityPlugin.setupMiddleware?.(ctx);
  await entityPlugin.setupRoutes?.(ctx);

  // The package's vote-guard middleware reads adapter refs that are normally
  // populated by the framework's `onAdapter` callbacks on each entity module.
  // This test helper bypasses `compilePackages()`, so we drive the same hooks
  // manually with the shared adapters resolved by the entity-plugin step
  // above.
  for (const entityModule of plugin.entities) {
    const impl = (entityModule as { implementation?: unknown }).implementation as
      | { wiring?: { mode?: string; onAdapter?: (adapter: BareEntityAdapter) => void } }
      | undefined;
    const wiring = impl?.wiring;
    if (wiring?.mode === 'factories') {
      if (entityModule.entityName === 'Poll' && sharedAdapters.poll) {
        wiring.onAdapter?.(sharedAdapters.poll);
      } else if (entityModule.entityName === 'PollVote' && sharedAdapters.pollVote) {
        wiring.onAdapter?.(sharedAdapters.pollVote);
      }
    }
  }

  await plugin.setupRoutes?.(ctx);
  await entityPlugin.setupPost?.(ctx);
  await plugin.setupPost?.(ctx);

  const state = readPluginState(pluginState, POLLS_RUNTIME_KEY);
  if (!state) throw new Error('Polls package did not register state — lifecycle failed');

  return { app, state, bus };
}
