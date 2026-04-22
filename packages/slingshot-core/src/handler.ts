import { type ZodTypeAny, z } from 'zod';
import type { SlingshotContext } from './context/slingshotContext';
import { ValidationError } from './errors';
import { ANONYMOUS_ACTOR, type Actor } from './identity';

/**
 * Safely resolve the canonical {@link Actor} from a {@link HandlerMeta} object.
 *
 * Prefers `meta.actor` when present. Falls back to constructing an `Actor` from
 * the legacy `authUserId` / `bearerClientId` / `authClientId` fields when
 * `meta.actor` is absent (e.g., in externally constructed or test-created meta
 * objects that predate the actor migration).
 *
 * @param meta - The handler invocation metadata to extract the actor from.
 * @returns The canonical `Actor` for this invocation — never `null`.
 */
export function resolveActor(meta: HandlerMeta): Actor {
  if (meta.actor) return meta.actor;
  return buildActorFromLegacy(meta);
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Invocation metadata for a transport-agnostic handler call.
 *
 * Every handler invocation receives a `HandlerMeta` describing the request
 * context: who made the call, tracing identifiers, and optional HTTP details.
 * Guards, after-hooks, and the handler itself all share the same `meta` instance.
 */
export interface HandlerMeta {
  /** Framework-assigned unique identifier for this invocation. */
  requestId: string;

  /** The resolved actor for this request. */
  actor: Actor;

  /** @deprecated Use `meta.actor.tenantId`. */
  tenantId: string | null;
  /** @deprecated Use `meta.actor.id`. */
  authUserId: string | null;
  /** @deprecated Use `meta.actor.roles`. */
  roles?: string[] | null;

  /**
   * Distributed-tracing correlation identifier.
   *
   * Defaults to `requestId` when no upstream correlation header is present.
   * Propagate this value when making downstream calls to preserve trace continuity.
   */
  correlationId: string;
  /** Client IP address, or `null` when unavailable (e.g. direct invocation). */
  ip: string | null;
  /**
   * Caller-supplied idempotency key for exactly-once semantics.
   *
   * When present, the idempotency guard can short-circuit execution and return
   * a cached result via {@link IdempotencyCacheHit}.
   */
  idempotencyKey?: string;

  /** @deprecated Use `meta.actor.kind === 'service-account'` and `meta.actor.id`. */
  authClientId?: string | null;
  /** @deprecated Use `meta.actor.kind === 'api-key'` and `meta.actor.id`. */
  bearerClientId?: string | null;
  /** Whether the request was authenticated via a bearer token. */
  bearerAuthenticated?: boolean;
  /** HTTP method of the originating request (e.g. `'GET'`, `'POST'`). */
  method?: string;
  /** URL path of the originating request. */
  path?: string;
  /** `User-Agent` header value, or `null` when unavailable. */
  userAgent?: string | null;
}

/**
 * Structured transport-agnostic handler failure.
 *
 * Throw a `HandlerError` from guards or handlers to signal a well-defined
 * failure with an HTTP-style status code, optional machine-readable error
 * code, and arbitrary detail payload. The framework serialises these into
 * the appropriate transport response.
 *
 * @example
 * ```ts
 * throw new HandlerError('Insufficient credits', {
 *   status: 402,
 *   code: 'CREDITS_EXHAUSTED',
 *   details: { remaining: 0 },
 * });
 * ```
 */
export class HandlerError extends Error {
  /** HTTP-style status code (defaults to `500`). */
  readonly status: number;
  /** Machine-readable error code for programmatic consumers. */
  readonly code?: string;
  /** Arbitrary structured payload surfaced alongside the error message. */
  readonly details?: Record<string, unknown>;

  /**
   * @param message - Human-readable error description.
   * @param opts - Optional status code, error code, and detail payload.
   */
  constructor(
    message: string,
    opts?: {
      status?: number;
      code?: string;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = 'HandlerError';
    this.status = opts?.status ?? 500;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

/**
 * Arguments passed to guards, handlers, and after hooks.
 *
 * Every callback in the handler pipeline receives the same `HandlerArgs`
 * instance, giving uniform access to validated input, the app context,
 * invocation metadata, and the handler's registered name.
 */
export interface HandlerArgs<TInput extends ZodTypeAny = ZodTypeAny> {
  /** Validated and parsed handler input (output type of the input schema). */
  input: z.output<TInput>;
  /** Instance-scoped Slingshot application context. */
  ctx: SlingshotContext;
  /** Invocation metadata for this handler call. */
  meta: HandlerMeta;
  /** The registered name of the handler being invoked. */
  handlerName: string;
}

/**
 * A transport-agnostic pre-handle check.
 *
 * Guards run sequentially before the handler. A guard that throws prevents
 * subsequent guards and the handler from executing. Throw {@link HandlerError}
 * to signal a structured failure, or any `Error` for unexpected conditions.
 *
 * Return `void` (or a resolved promise) to allow the pipeline to continue.
 */
export type Guard<TInput extends ZodTypeAny = ZodTypeAny> = (
  args: HandlerArgs<TInput>,
) => MaybePromise<void>;

/**
 * A transport-agnostic post-handle side effect.
 *
 * After hooks run sequentially once the handler returns a validated output.
 * They receive the same {@link HandlerArgs} plus the handler's `output`.
 * Failures in after hooks are logged but do **not** prevent the response
 * from being returned to the caller.
 */
export type AfterHook<TInput extends ZodTypeAny = ZodTypeAny, TOutput = unknown> = (
  args: HandlerArgs<TInput> & { output: TOutput },
) => MaybePromise<void>;

/** Discriminator for HTTP authentication schemes a guard may require. */
type HttpAuthRequirement = 'userAuth' | 'bearer';

/**
 * A {@link Guard} that carries optional metadata used by the handler pipeline.
 *
 * Guards that attach an `_afterHook` have that hook automatically collected
 * and appended to the after-hook list when the handler is invoked.
 */
export interface GuardWithMetadata<TInput extends ZodTypeAny = ZodTypeAny> extends Guard<TInput> {
  /** After hook paired with this guard, automatically collected by the pipeline. */
  readonly _afterHook?: AfterHook<TInput>;
  /** HTTP auth scheme this guard requires, used by transport layers. */
  readonly _httpAuth?: HttpAuthRequirement;
}

/**
 * Sentinel used by the idempotency guard to short-circuit execution.
 *
 * When a guard detects that a request carries an {@link HandlerMeta.idempotencyKey}
 * that has already been processed, it throws an `IdempotencyCacheHit` carrying
 * the previously computed output. The handler pipeline catches this sentinel,
 * validates the cached output against the output schema, and returns it
 * without re-running the handler or after hooks.
 */
export class IdempotencyCacheHit extends Error {
  /** The previously computed and cached handler output. */
  readonly cachedOutput: unknown;

  /**
   * @param cachedOutput - The handler output from the original invocation.
   */
  constructor(cachedOutput: unknown) {
    super('Idempotency cache hit');
    this.name = 'IdempotencyCacheHit';
    this.cachedOutput = cachedOutput;
  }
}

/**
 * Configuration for {@link defineHandler}.
 *
 * Describes the handler's name, input/output schemas, optional guard pipeline,
 * optional after-hook pipeline, and the core handler function.
 */
export interface HandlerConfig<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  /** Unique handler name used for logging, metrics, and route registration. */
  name: string;
  /** Zod schema for validating and parsing incoming input. */
  input: TInput;
  /** Zod schema for validating the handler's return value before it is sent. */
  output: TOutput;
  /** Guards to run sequentially before the handler. */
  guards?: readonly Guard<TInput>[];
  /** After hooks to run sequentially once the handler returns a validated output. */
  after?: readonly AfterHook<TInput, z.output<TOutput>>[];
  /**
   * Core handler function that processes validated input and returns the output.
   *
   * @param args - Validated input, app context, and invocation metadata.
   * @returns The handler result — must conform to the `output` schema.
   */
  handle(args: HandlerArgs<TInput>): MaybePromise<z.output<TOutput>>;
}

/**
 * Options for directly invoking a {@link SlingshotHandler} outside of a
 * transport layer (e.g. from tests, CLI commands, or inter-handler calls).
 */
export interface InvokeOpts {
  /** Instance-scoped Slingshot application context. */
  ctx: SlingshotContext;
  /**
   * Partial invocation metadata. Missing fields are filled with sensible
   * defaults (random `requestId`, {@link ANONYMOUS_ACTOR}, etc.).
   */
  meta?: Partial<HandlerMeta>;
}

/**
 * A transport-agnostic handler instance created by {@link defineHandler}.
 *
 * The handler can be invoked directly via {@link SlingshotHandler.invoke} or
 * mounted onto an HTTP transport by the framework's route registration layer.
 * The instance is deeply frozen — its configuration cannot be mutated after
 * creation.
 */
export interface SlingshotHandler<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  /** The handler's registered name (matches {@link HandlerConfig.name}). */
  readonly name: string;
  /** Zod schema used to validate incoming input. */
  readonly input: TInput;
  /** Zod schema used to validate the handler's return value. */
  readonly output: TOutput;
  /** Frozen array of guards that run before the handler. */
  readonly guards: readonly Guard<TInput>[];
  /** Frozen array of after hooks that run after the handler returns. */
  readonly after: readonly AfterHook<TInput, z.output<TOutput>>[];
  /**
   * Invoke the full handler pipeline: input validation → guards → handle → output validation → after hooks.
   *
   * @param raw - Raw (unparsed) input that will be validated against the input schema.
   * @param opts - Application context and optional invocation metadata.
   * @returns The validated handler output.
   * @throws {ValidationError} When input or output fails schema validation.
   * @throws {HandlerError} When a guard or the handler signals a structured failure.
   */
  invoke(raw: z.input<TInput>, opts: InvokeOpts): Promise<z.output<TOutput>>;
}

function defaultMeta(meta: Partial<HandlerMeta> | undefined): HandlerMeta {
  const requestId = meta?.requestId ?? crypto.randomUUID();

  // Prefer an explicitly supplied actor; otherwise construct one from legacy fields.
  const actor: Actor = meta?.actor ?? buildActorFromLegacy(meta);

  return {
    requestId,
    actor,
    // Legacy aliases — projected from actor so both views stay in sync.
    tenantId: actor.tenantId,
    authUserId: actor.kind === 'user' ? actor.id : null,
    roles: actor.roles,
    correlationId: meta?.correlationId ?? requestId,
    ip: meta?.ip ?? null,
    ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
    authClientId: actor.kind === 'service-account' ? actor.id : (meta?.authClientId ?? null),
    bearerClientId: actor.kind === 'api-key' ? actor.id : (meta?.bearerClientId ?? null),
    bearerAuthenticated: meta?.bearerAuthenticated ?? false,
    method: meta?.method,
    path: meta?.path,
    userAgent: meta?.userAgent ?? null,
  };
}

/**
 * Build an Actor from the legacy HandlerMeta fields when no explicit actor is provided.
 * This preserves backward compatibility for callers that construct HandlerMeta without actor.
 */
function buildActorFromLegacy(meta: Partial<HandlerMeta> | undefined): Actor {
  if (!meta) return ANONYMOUS_ACTOR;

  const tenantId = meta.tenantId ?? null;
  const roles = meta.roles ?? null;

  if (meta.authUserId) {
    return {
      id: meta.authUserId,
      kind: 'user',
      tenantId,
      sessionId: null,
      roles,
      claims: {},
    };
  }
  if (meta.bearerClientId) {
    return {
      id: meta.bearerClientId,
      kind: 'api-key',
      tenantId,
      sessionId: null,
      roles,
      claims: {},
    };
  }
  if (meta.authClientId) {
    return {
      id: meta.authClientId,
      kind: 'service-account',
      tenantId,
      sessionId: null,
      roles,
      claims: {},
    };
  }
  return { ...ANONYMOUS_ACTOR, tenantId };
}

function collectAfterHooks<TInput extends ZodTypeAny, TOutput>(
  guards: readonly Guard<TInput>[],
  after: readonly AfterHook<TInput, TOutput>[],
): readonly AfterHook<TInput, TOutput>[] {
  const paired = guards.flatMap(guard => {
    const candidate = guard as GuardWithMetadata<TInput>;
    return candidate._afterHook ? [candidate._afterHook as AfterHook<TInput, TOutput>] : [];
  });
  return Object.freeze([...after, ...paired]);
}

function validateOutput<TOutput extends ZodTypeAny>(
  schema: TOutput,
  value: unknown,
): z.output<TOutput> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Define a transport-agnostic handler.
 *
 * Returns a frozen {@link SlingshotHandler} whose {@link SlingshotHandler.invoke}
 * method runs the full pipeline: input validation → guards → handle → output
 * validation → after hooks. Guards that carry an `_afterHook` are automatically
 * collected and appended to the after-hook list.
 *
 * @param config - Handler name, schemas, guards, after hooks, and the handler function.
 * @returns A frozen handler instance ready for direct invocation or transport mounting.
 *
 * @example
 * ```ts
 * const getUser = defineHandler({
 *   name: 'getUser',
 *   input: z.object({ id: z.string().uuid() }),
 *   output: UserSchema,
 *   guards: [requireAuth],
 *   async handle({ input, ctx }) {
 *     return ctx.repos.users.findById(input.id);
 *   },
 * });
 * ```
 */
export function defineHandler<TInput extends ZodTypeAny, TOutput extends ZodTypeAny>(
  config: HandlerConfig<TInput, TOutput>,
): SlingshotHandler<TInput, TOutput> {
  const frozenGuards = Object.freeze([...(config.guards ?? [])]);
  const frozenAfter = Object.freeze([...(config.after ?? [])]);

  return Object.freeze({
    name: config.name,
    input: config.input,
    output: config.output,
    guards: frozenGuards,
    after: frozenAfter,

    async invoke(raw: z.input<TInput>, opts: InvokeOpts) {
      const parsed = config.input.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues);
      }

      const args: HandlerArgs<TInput> = {
        input: parsed.data,
        ctx: opts.ctx,
        meta: defaultMeta(opts.meta),
        handlerName: config.name,
      };

      try {
        for (const guard of frozenGuards) {
          await guard(args);
        }
      } catch (error) {
        if (error instanceof IdempotencyCacheHit) {
          return validateOutput(config.output, error.cachedOutput);
        }
        throw error;
      }

      const output = validateOutput(config.output, await config.handle(args));
      const allAfter = collectAfterHooks(frozenGuards, frozenAfter);
      for (const hook of allAfter) {
        try {
          await hook({ ...args, output });
        } catch (error) {
          console.error(`[handler:${config.name}] after hook failed:`, error);
        }
      }

      return output;
    },
  });
}
