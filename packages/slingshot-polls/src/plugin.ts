/**
 * Polls plugin factory.
 *
 * Creates a `SlingshotPlugin` that registers the Poll and PollVote entities,
 * mounts the vote guard and create guard, the results route, and the
 * auto-close sweep interval.
 *
 * Every adapter, middleware, sweep handle, and rate-limit tracker is built
 * via a factory that captures state in closure (Rule 3). Multiple plugin
 * instances in the same process do not share state.
 *
 * @param rawConfig - Plugin configuration. See {@link PollsPluginConfig}.
 * @returns A `SlingshotPlugin` ready to pass to `createApp({ plugins: [...] })`.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  PluginSetupContext,
  SlingshotPlugin,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getPluginState,
  resolveRepo,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { PolicyResolver } from '@lastshotlabs/slingshot-core';
import {
  createEntityPlugin,
  getEntityPolicyResolver,
  registerEntityPolicy,
  resolvePolicy,
} from '@lastshotlabs/slingshot-entity';
import type { EntityPlugin, EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { pollFactories, pollVoteFactories } from './entities/factories';
import { Poll } from './entities/poll';
import { PollVote } from './entities/pollVote';
import { startCloseSweep } from './lib/closeSweep';
import { buildRateLimitMiddleware, createInMemoryRateLimiter } from './lib/rateLimit';
import { buildPollCreateGuard } from './middleware/pollCreateGuard';
import { buildPollVoteGuard } from './middleware/pollVoteGuard';
import { pollOperations, pollVoteOperations } from './operations/index';
import { createResultsHandler } from './operations/results';
import {
  POLL_SOURCE_POLICY_KEY,
  POLL_VOTE_POLICY_KEY,
  createPollSourcePolicy,
  createPollVotePolicy,
} from './policy';
import type { PollAdapter, PollVoteAdapter } from './types/adapters';
import {
  POLLS_PLUGIN_STATE_KEY,
  type PollRecord,
  type PollVoteRecord,
  type PollsPluginConfig,
  type PollsPluginState,
} from './types/public';
import { PollsPluginConfigSchema } from './validation/config';
import { buildPollSchemas } from './validation/polls';
import { PollResultsParamsSchema } from './validation/results';

type AdapterResult = BareEntityAdapter;

/**
 * Create the polls plugin.
 *
 * @example
 * ```ts
 * import { createPollsPlugin } from '@lastshotlabs/slingshot-polls';
 *
 * const polls = createPollsPlugin({ mountPath: '/polls' });
 * const app = createApp({ plugins: [polls] });
 * ```
 */
export function createPollsPlugin(rawConfig: Partial<PollsPluginConfig> = {}): SlingshotPlugin & {
  /** Register a per-sourceType policy handler. Call before `setupMiddleware`. */
  registerSourceHandler: (sourceType: string, handler: unknown, entity?: 'poll' | 'vote') => void;
} {
  // Validate + freeze config at construction time (Rule 12).
  const config = deepFreeze(
    validatePluginConfig(POLLS_PLUGIN_STATE_KEY, rawConfig, PollsPluginConfigSchema),
  );

  // Closure-owned state - no module-level singletons (Rule 3).
  let pollAdapter: PollAdapter | undefined;
  let pollVoteAdapter: PollVoteAdapter | undefined;
  let innerPlugin: EntityPlugin | undefined;
  let sweepHandle: { stop(): void } | undefined;

  // Closure-owned handler maps for policy dispatch (Rule 3).
  const sourceHandlers = new Map<string, PolicyResolver<PollRecord, Partial<PollRecord>>>();
  const voteHandlers = new Map<string, PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>>>();

  /**
   * Register a per-sourceType policy handler for poll authorization.
   *
   * Call before `setupMiddleware` so the policy dispatch table picks up the
   * handler. Two entity targets are supported: `'poll'` for poll CRUD and
   * `'vote'` for vote operations.
   *
   * @param sourceType - The discriminator value (e.g. `'chat:message'`).
   * @param handler - The policy resolver function.
   * @param entity - Which entity the handler applies to. Default: `'poll'`.
   */
  function registerSourceHandler(
    sourceType: string,
    handler: unknown,
    entity: 'poll' | 'vote' = 'poll',
  ): void {
    if (entity === 'vote') {
      voteHandlers.set(
        sourceType,
        handler as PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>>,
      );
    } else {
      sourceHandlers.set(sourceType, handler as PolicyResolver<PollRecord, Partial<PollRecord>>);
    }
  }

  // Build parameterized Zod schemas from config limits.
  const { PollCreateInputSchema } = buildPollSchemas({
    maxOptions: config.maxOptions,
    maxQuestionLength: config.maxQuestionLength,
    maxOptionLength: config.maxOptionLength,
  });
  const pollCreateGuard = buildPollCreateGuard({ schema: PollCreateInputSchema });

  // Build rate-limit middleware closures. When config.rateLimit is absent,
  // the middleware is a noop passthrough. The backend is closure-owned (Rule 3).
  const rateLimitBackend = config.rateLimit ? createInMemoryRateLimiter() : null;

  const middleware: Record<string, MiddlewareHandler> = {
    pollCreateGuard,
    pollVoteGuard: async (c, next) => {
      if (!pollAdapter || !pollVoteAdapter) {
        throw new Error(
          '[slingshot-polls] Adapters not resolved - middleware called before entity setup.',
        );
      }
      return buildPollVoteGuard({ pollAdapter, pollVoteAdapter })(c, next);
    },
    pollVoteRateLimit:
      config.rateLimit?.vote && rateLimitBackend
        ? buildRateLimitMiddleware('vote', config.rateLimit.vote, rateLimitBackend)
        : async (_c, next) => next(),
    pollCreateRateLimit:
      config.rateLimit?.pollCreate && rateLimitBackend
        ? buildRateLimitMiddleware('pollCreate', config.rateLimit.pollCreate, rateLimitBackend)
        : async (_c, next) => next(),
  };

  // Entity entries for createEntityPlugin.
  const entities: EntityPluginEntry[] = [
    {
      config: Poll,
      operations: pollOperations.operations,
      buildAdapter: (storeType: StoreType, infra: StoreInfra): AdapterResult => {
        const adapter = resolveRepo(pollFactories, storeType, infra);
        pollAdapter = adapter as unknown as PollAdapter;
        return adapter as unknown as AdapterResult;
      },
    },
    {
      config: PollVote,
      operations: pollVoteOperations.operations,
      buildAdapter: (storeType: StoreType, infra: StoreInfra): AdapterResult => {
        const adapter = resolveRepo(pollVoteFactories, storeType, infra);
        pollVoteAdapter = adapter as unknown as PollVoteAdapter;
        return adapter as unknown as AdapterResult;
      },
    },
  ];

  return {
    name: POLLS_PLUGIN_STATE_KEY,
    dependencies: ['slingshot-auth'],
    registerSourceHandler,

    async setupMiddleware(ctx: PluginSetupContext) {
      // Register dispatched policy resolvers before entity routes are mounted.
      // Consumer plugins register their per-sourceType handlers via
      // plugin.registerSourceHandler() before this lifecycle phase.
      registerEntityPolicy(ctx.app, POLL_SOURCE_POLICY_KEY, createPollSourcePolicy(sourceHandlers));
      registerEntityPolicy(ctx.app, POLL_VOTE_POLICY_KEY, createPollVotePolicy(voteHandlers));

      innerPlugin ??= createEntityPlugin({
        name: POLLS_PLUGIN_STATE_KEY,
        mountPath: config.mountPath,
        entities,
        middleware,
      });

      await innerPlugin?.setupMiddleware?.(ctx);
    },

    async setupRoutes({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.({ app, config: frameworkConfig, bus, events });

      // Mount the results route manually - needs cross-entity access.
      if (
        pollAdapter &&
        pollVoteAdapter &&
        !config.disableRoutes.includes('poll.results' as never)
      ) {
        const resolvedPollAdapter = pollAdapter;
        const resolvedPollVoteAdapter = pollVoteAdapter;
        const resultsHandler = createResultsHandler({
          pollAdapter: resolvedPollAdapter,
          pollVoteAdapter: resolvedPollVoteAdapter,
        });

        const resultsRoutes = new Hono();
        // Wire rate-limit middleware on the results route if configured.
        if (config.rateLimit?.results && rateLimitBackend) {
          resultsRoutes.use(
            '/:id/results',
            buildRateLimitMiddleware('results', config.rateLimit.results, rateLimitBackend),
          );
        }
        resultsRoutes.get('/:id/results', async c => {
          const parseResult = PollResultsParamsSchema.safeParse({
            id: c.req.param('id'),
          });
          if (!parseResult.success) {
            throw new HTTPException(400, { message: 'Invalid poll ID' });
          }

          // The results route is mounted manually - enforce the source
          // policy explicitly against the fetched poll record.
          const poll = await resolvedPollAdapter.getById(parseResult.data.id);
          if (!poll) throw new HTTPException(404, { message: 'Poll not found' });

          const policyResolver = getEntityPolicyResolver(app, POLL_SOURCE_POLICY_KEY);
          if (policyResolver) {
            await resolvePolicy({
              c,
              config: { resolver: POLL_SOURCE_POLICY_KEY },
              resolver: policyResolver,
              action: { kind: 'operation', name: 'results' },
              record: poll,
              input: null,
            });
          }

          const response = await resultsHandler(parseResult.data.id);
          return c.json(response);
        });
        app.route(`${config.mountPath}/polls`, resultsRoutes);
      }
    },

    async setupPost({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      await innerPlugin?.setupPost?.({ app, config: frameworkConfig, bus, events });

      if (!pollAdapter || !pollVoteAdapter) {
        throw new Error('[slingshot-polls] Adapters not resolved after entity plugin setup.');
      }

      // Start auto-close sweep.
      sweepHandle = startCloseSweep({
        pollAdapter,
        bus,
        intervalMs: config.closeCheckIntervalMs,
      });

      // Register plugin state (Rule 18 - instance-scoped context).
      const state: PollsPluginState = deepFreeze({
        config,
        pollAdapter,
        pollVoteAdapter,
        sweepHandle,
        registerSourceHandler,
      });
      getPluginState(app).set(POLLS_PLUGIN_STATE_KEY, state);
    },

    teardown() {
      sweepHandle?.stop();
    },
  };
}
