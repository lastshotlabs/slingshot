import { type ZodTypeAny, z } from 'zod';
import type { SlingshotContext } from './context/slingshotContext';
import { ValidationError } from './errors';
import { ANONYMOUS_ACTOR, type Actor } from './identity';

/**
 * Safely resolve the actor from HandlerMeta, falling back to legacy fields
 * when actor is not present (e.g., externally constructed meta objects).
 */
export function resolveActor(meta: HandlerMeta): Actor {
  if (meta.actor) return meta.actor;
  return buildActorFromLegacy(meta);
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Invocation metadata for a transport-agnostic handler call.
 */
export interface HandlerMeta {
  requestId: string;

  /** The resolved actor for this request. */
  actor: Actor;

  /** @deprecated Use `meta.actor.tenantId`. */
  tenantId: string | null;
  /** @deprecated Use `meta.actor.id`. */
  authUserId: string | null;
  /** @deprecated Use `meta.actor.roles`. */
  roles?: string[] | null;

  correlationId: string;
  ip: string | null;
  idempotencyKey?: string;

  /** @deprecated Use `meta.actor.kind === 'service-account'` and `meta.actor.id`. */
  authClientId?: string | null;
  /** @deprecated Use `meta.actor.kind === 'api-key'` and `meta.actor.id`. */
  bearerClientId?: string | null;
  bearerAuthenticated?: boolean;
  method?: string;
  path?: string;
  userAgent?: string | null;
}

/**
 * Structured transport-agnostic handler failure.
 */
export class HandlerError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

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
 */
export interface HandlerArgs<TInput extends ZodTypeAny = ZodTypeAny> {
  input: z.output<TInput>;
  ctx: SlingshotContext;
  meta: HandlerMeta;
  handlerName: string;
}

/**
 * A transport-agnostic pre-handle check.
 */
export type Guard<TInput extends ZodTypeAny = ZodTypeAny> = (
  args: HandlerArgs<TInput>,
) => MaybePromise<void>;

/**
 * A transport-agnostic post-handle side effect.
 */
export type AfterHook<TInput extends ZodTypeAny = ZodTypeAny, TOutput = unknown> = (
  args: HandlerArgs<TInput> & { output: TOutput },
) => MaybePromise<void>;

type HttpAuthRequirement = 'userAuth' | 'bearer';

export interface GuardWithMetadata<TInput extends ZodTypeAny = ZodTypeAny> extends Guard<TInput> {
  readonly _afterHook?: AfterHook<TInput>;
  readonly _httpAuth?: HttpAuthRequirement;
}

/**
 * Sentinel used by the idempotency guard to short-circuit execution.
 */
export class IdempotencyCacheHit extends Error {
  readonly cachedOutput: unknown;

  constructor(cachedOutput: unknown) {
    super('Idempotency cache hit');
    this.name = 'IdempotencyCacheHit';
    this.cachedOutput = cachedOutput;
  }
}

/**
 * Configuration for `defineHandler()`.
 */
export interface HandlerConfig<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  name: string;
  input: TInput;
  output: TOutput;
  guards?: readonly Guard<TInput>[];
  after?: readonly AfterHook<TInput, z.output<TOutput>>[];
  handle(args: HandlerArgs<TInput>): MaybePromise<z.output<TOutput>>;
}

/**
 * Options for direct invocation.
 */
export interface InvokeOpts {
  ctx: SlingshotContext;
  meta?: Partial<HandlerMeta>;
}

/**
 * A transport-agnostic handler instance.
 */
export interface SlingshotHandler<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  readonly name: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly guards: readonly Guard<TInput>[];
  readonly after: readonly AfterHook<TInput, z.output<TOutput>>[];
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
