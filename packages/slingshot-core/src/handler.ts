import { z, type ZodTypeAny } from 'zod';
import { ValidationError } from './errors';
import type { SlingshotContext } from './context/slingshotContext';

type MaybePromise<T> = T | Promise<T>;

/**
 * Invocation metadata for a transport-agnostic handler call.
 */
export interface HandlerMeta {
  requestId: string;
  tenantId: string | null;
  authUserId: string | null;
  correlationId: string;
  ip: string | null;
  idempotencyKey?: string;
  authClientId?: string | null;
  bearerClientId?: string | null;
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
export type AfterHook<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput = unknown,
> = (args: HandlerArgs<TInput> & { output: TOutput }) => MaybePromise<void>;

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
  return {
    requestId,
    tenantId: meta?.tenantId ?? null,
    authUserId: meta?.authUserId ?? null,
    correlationId: meta?.correlationId ?? requestId,
    ip: meta?.ip ?? null,
    ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
    authClientId: meta?.authClientId ?? null,
    bearerClientId: meta?.bearerClientId ?? null,
  };
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

    async invoke(raw, opts) {
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
