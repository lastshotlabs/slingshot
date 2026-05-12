/**
 * Polls package factory.
 *
 * Creates a `SlingshotPackageDefinition` that mounts the Poll and PollVote
 * entities, the vote and create guards, the results route, and the auto-close
 * sweep interval.
 *
 * Every adapter, middleware, sweep handle, and rate-limit tracker is built
 * via a factory that captures state in closure (Rule 3). Multiple package
 * instances in the same process do not share state.
 *
 * @param rawConfig - Package configuration. See {@link PollsPluginConfig}.
 * @returns A `SlingshotPackageDefinition` ready to pass to `createApp({ packages: [...] })`.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  PluginSetupContext,
  PolicyResolver,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  definePackage,
  getPluginState,
  provideCapability,
  publishPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { PollsRuntimeCap } from './public';
import {
  getEntityPolicyResolver,
  registerEntityPolicy,
  resolvePolicy,
} from '@lastshotlabs/slingshot-entity';
import { buildPollEntityModules } from './entities/modules';
import { startCloseSweep } from './lib/closeSweep';
import { buildRateLimitMiddleware, createInMemoryRateLimiter } from './lib/rateLimit';
import { buildPollCreateGuard } from './middleware/pollCreateGuard';
import { buildPollVoteGuard } from './middleware/pollVoteGuard';
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
  POLLS_RUNTIME_KEY,
  type PollRecord,
  type PollVoteRecord,
  type PollsPluginConfig,
  type PollsPluginState,
} from './types/public';
import { PollsPluginConfigSchema } from './validation/config';
import { buildPollSchemas } from './validation/polls';
import { PollResultsParamsSchema } from './validation/results';

/**
 * Create the polls package.
 *
 * Per-sourceType policy handlers for poll authorization are declared on the
 * `sourceHandlers` (and `voteHandlers`) config fields. There is no runtime
 * `registerSourceHandler` — apps know which source types they expose at
 * package construction time.
 *
 * @example
 * ```ts
 * import { createPollsPackage } from '@lastshotlabs/slingshot-polls';
 *
 * const polls = createPollsPackage({
 *   mountPath: '/polls',
 *   sourceHandlers: {
 *     'chat:message': chatPollResolver,
 *   },
 *   voteHandlers: {
 *     'chat:message': chatVoteResolver,
 *   },
 * });
 * const app = createApp({ packages: [polls] });
 * ```
 */
export function createPollsPackage(
  rawConfig: Partial<PollsPluginConfig> = {},
): SlingshotPackageDefinition {
  // Validate + freeze config at construction time (Rule 12).
  const config = deepFreeze(
    validatePluginConfig(POLLS_PLUGIN_STATE_KEY, rawConfig, PollsPluginConfigSchema),
  ) as PollsPluginConfig;

  // Closure-owned adapter refs populated by the entity modules' `onAdapter`
  // callbacks during bootstrap. The vote-guard middleware, close sweep, and
  // /results route all read from these refs.
  //
  // The adapters here are the SAME instances the entity-plugin routes use —
  // critical for memory-store correctness, since memory adapters carry state
  // per-instance and a second `resolveRepo` call would create a divergent
  // store.
  let pollAdapter: PollAdapter | undefined;
  let pollVoteAdapter: PollVoteAdapter | undefined;
  let sweepHandle: { stop(): void } | undefined;
  // Hoisted runtime ref read by the declarative `PollsRuntimeCap` resolver.
  // Populated in setupPost; resolver throws a clear "not ready" error when
  // read earlier.
  let runtimeStateRef: PollsPluginState | undefined;

  const { pollModule, pollVoteModule } = buildPollEntityModules({
    onPollAdapter: adapter => {
      pollAdapter = adapter as unknown as PollAdapter;
    },
    onPollVoteAdapter: adapter => {
      pollVoteAdapter = adapter as unknown as PollVoteAdapter;
    },
  });

  // Frozen handler maps derived from config. `sourceHandlers` and `voteHandlers`
  // are Records on the config; the policy factory expects Maps, so we adapt
  // once here.
  const sourceHandlers = new Map<string, PolicyResolver<PollRecord, Partial<PollRecord>>>(
    Object.entries(
      (config.sourceHandlers ?? {}) as Record<
        string,
        PolicyResolver<PollRecord, Partial<PollRecord>>
      >,
    ),
  );
  const voteHandlers = new Map<
    string,
    PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>>
  >(
    Object.entries(
      (config.voteHandlers ?? {}) as Record<
        string,
        PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>>
      >,
    ),
  );

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

  return definePackage({
    name: POLLS_PLUGIN_STATE_KEY,
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth'],
    entities: [pollModule, pollVoteModule],
    middleware,
    capabilities: {
      provides: [
        // Return a Proxy: the framework eagerly resolves capability values at
        // setupMiddleware time, before our setupPost populates the runtime
        // state. Field access throws a clear error if reached before
        // setupPost has run.
        provideCapability(PollsRuntimeCap, () => {
          const target: PollsPluginState = Object.create(null) as PollsPluginState;
          return new Proxy(target, {
            get(_target, prop, receiver) {
              if (typeof prop === 'symbol' || prop === 'then') return undefined;
              if (!runtimeStateRef) {
                throw new Error(
                  `[slingshot-polls] runtime.${String(prop)} accessed before setupPost completed; resolve PollsRuntimeCap from setupPost or later.`,
                );
              }
              return Reflect.get(runtimeStateRef, prop, receiver);
            },
          });
        }),
      ],
    },

    setupMiddleware(ctx: PluginSetupContext) {
      // Register dispatched policy resolvers before entity routes are mounted.
      // Handler maps come from config (Option 3 in the package-migration spec).
      // Entity adapter refs are populated by the entity modules' onAdapter
      // hooks during the framework's entity-bootstrap step, which runs after
      // setupMiddleware completes — middleware closures that reference the
      // refs (pollVoteGuard) are only invoked at request time, by which point
      // both refs are populated.
      registerEntityPolicy(
        ctx.app,
        POLL_SOURCE_POLICY_KEY,
        createPollSourcePolicy(sourceHandlers),
      );
      registerEntityPolicy(ctx.app, POLL_VOTE_POLICY_KEY, createPollVotePolicy(voteHandlers));
    },

    setupRoutes({ app }: PluginSetupContext) {
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

    setupPost({ app, bus }: PluginSetupContext) {
      if (!pollAdapter || !pollVoteAdapter) {
        throw new Error('[slingshot-polls] Adapters not resolved after entity package setup.');
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
      });
      // Legacy plugin-state slot — preserved for back-compat with consumers
      // that read the runtime via `getPluginState(app).get(POLLS_RUNTIME_KEY)`.
      // New code should resolve `PollsRuntimeCap` through `ctx.capabilities`.
      publishPluginState(getPluginState(app), POLLS_RUNTIME_KEY, state);
      // Populate the hoisted ref so the declarative PollsRuntimeCap resolver
      // stops throwing.
      runtimeStateRef = state;
    },

    teardown() {
      sweepHandle?.stop();
    },
  });
}
