import {
  ANONYMOUS_ACTOR,
  type FunctionsHooks,
  HandlerError,
  type HandlerMeta,
  type IdentityResolver,
  type Logger,
  type RecordOutcome,
  type SlingshotContext,
  type SlingshotHandler,
  type TriggerAdapter,
  type TriggerOpts,
  type TriggerRecord,
  ValidationError,
  createConsoleLogger,
} from '@lastshotlabs/slingshot-core';
import { IdempotencyConflictError, invokeWithRecordIdempotency } from './idempotency';

/**
 * Structured `Logger` (slingshot-core) used for hook-exception events
 * (P-LAMBDA-2/-3) and other operational records that should be
 * machine-parseable. Defaults to a JSON console logger.
 */
let lambdaLogger: Logger = createConsoleLogger({ base: { runtime: 'lambda' } });

/**
 * Replace the runtime's structured logger. Pass `null` to reset to the
 * default JSON console logger. Returns the previous logger so tests can
 * save and restore state.
 */
export function configureRuntimeLambdaLogger(logger: Logger | null): Logger {
  const previous = lambdaLogger;
  lambdaLogger = logger ?? createConsoleLogger({ base: { runtime: 'lambda' } });
  return previous;
}

const RETRY_WHOLE_BATCH_TRIGGERS = new Set(['msk', 'kinesis', 'dynamodb-streams']);
const AUTO_IDEMPOTENT_TRIGGERS = new Set(['sqs', 'msk', 'kinesis', 'dynamodb-streams']);

/**
 * Race a handler invocation against a wall-clock timeout. On timeout the outer
 * promise rejects with a `HandlerError(status: 504, code: 'handler-timeout')`
 * so observability and retry policy treat it as a typed failure rather than a
 * hung promise. The handler itself keeps running until the platform reaps the
 * container — there is no AbortSignal contract on `SlingshotHandler.invoke()`.
 */
function raceWithHandlerTimeout<T>(op: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return op;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new HandlerError(`Handler exceeded ${timeoutMs}ms`, {
          status: 504,
          code: 'handler-timeout',
        }),
      );
    }, timeoutMs);
    op.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type LambdaContextLike = {
  awsRequestId?: string;
};

function classifyError(error: Error): 'validation' | 'handler' | 'idempotency' | 'unknown' {
  if (error instanceof ValidationError) return 'validation';
  if (error instanceof HandlerError) return 'handler';
  if (error instanceof IdempotencyConflictError) return 'idempotency';
  return 'unknown';
}

function buildMeta(
  adapter: TriggerAdapter,
  event: unknown,
  record: TriggerRecord,
  identityResolver: IdentityResolver,
  lambdaContext?: LambdaContextLike,
): HandlerMeta {
  const extracted = adapter.extractMeta(event, record);
  const requestId = extracted.requestId ?? lambdaContext?.awsRequestId ?? crypto.randomUUID();
  const tenantId = extracted.tenantId ?? null;

  // Triggers may either set `actor` directly (preferred for actor-aware sources
  // like API Gateway with a JWT authorizer) or supply raw identity fields and
  // let the configured `IdentityResolver` map them into the canonical Actor.
  const resolved =
    extracted.actor ??
    identityResolver.resolve({
      userId: extracted.userId ?? null,
      serviceAccountId: extracted.serviceAccountId ?? null,
      apiKeyId: extracted.apiKeyId ?? null,
      sessionId: null,
      roles: extracted.roles ?? null,
      tenantId,
      tokenPayload: null,
    });
  // Freeze actor at the meta boundary (Rule 10). Trigger-supplied actors and
  // resolver outputs may be mutable objects.
  const safe = resolved ?? ANONYMOUS_ACTOR;
  const actor = Object.isFrozen(safe) ? safe : Object.freeze(safe);

  return {
    requestId,
    actor,
    requestTenantId: tenantId,
    correlationId: extracted.correlationId ?? requestId,
    ip: extracted.ip ?? null,
    bearerAuthenticated: extracted.bearerAuthenticated ?? false,
    idempotencyKey: extracted.idempotencyKey,
    method: extracted.method,
    path: extracted.path,
    userAgent: extracted.userAgent ?? null,
  };
}

function resolveRuntimeIdempotency(
  adapter: TriggerAdapter,
  record: TriggerRecord,
  opts: TriggerOpts | undefined,
) {
  if (opts?.idempotency === false) return undefined;
  if (opts?.idempotency && typeof opts.idempotency === 'object') {
    return opts.idempotency;
  }
  if (opts?.idempotency === true) {
    return {};
  }
  if (AUTO_IDEMPOTENT_TRIGGERS.has(adapter.kind) && record.naturalKey) {
    return {};
  }
  return undefined;
}

export async function invokeWithAdapter(
  handler: SlingshotHandler,
  adapter: TriggerAdapter,
  event: unknown,
  ctx: SlingshotContext,
  hooks: FunctionsHooks | undefined,
  opts: TriggerOpts | undefined,
  isColdStart: boolean,
  lambdaContext?: LambdaContextLike,
  handlerTimeoutMs?: number,
): Promise<unknown> {
  const records = adapter.extractInputs(event);
  const outcomes: RecordOutcome[] = [];

  for (const record of records) {
    const meta = buildMeta(adapter, event, record, ctx.identityResolver, lambdaContext);
    const startedAt = Date.now();
    let output: unknown;
    let capturedError: Error | undefined;

    try {
      let aborted: Awaited<ReturnType<NonNullable<FunctionsHooks['beforeInvoke']>>> | undefined;
      let beforeInvokeFailed = false;
      try {
        aborted = await hooks?.beforeInvoke?.({
          input: record.body,
          meta,
          trigger: adapter.kind,
          isColdStart,
          ctx,
        });
      } catch (err) {
        // P-LAMBDA-2: a thrown beforeInvoke must not silently allow the
        // invocation to proceed with partial state. Log structurally,
        // re-throw as a HandlerError so the standard error path runs
        // (onError, outcome assembly) — `aborted` stays undefined and
        // we never reach the handler.
        beforeInvokeFailed = true;
        const wrapped =
          err instanceof Error
            ? err
            : new Error(typeof err === 'string' ? err : 'beforeInvoke hook threw');
        lambdaLogger.error('hook-threw', {
          hook: 'beforeInvoke',
          message: wrapped.message,
          stack: wrapped.stack,
          requestId: meta.requestId,
        });
        throw new HandlerError(`beforeInvoke hook failed: ${wrapped.message}`, {
          status: 500,
          code: 'hook-failed',
          details: { hook: 'beforeInvoke' },
        });
      }
      // Defensive: if the catch above re-threw, we should never reach here
      // with beforeInvokeFailed=true, but make the invariant explicit.
      void beforeInvokeFailed;
      if (aborted && typeof aborted === 'object' && 'abort' in aborted && aborted.abort) {
        output = aborted.response;
      } else {
        output = await invokeWithRecordIdempotency(
          ctx,
          handler.name,
          meta,
          record,
          resolveRuntimeIdempotency(adapter, record, opts),
          async () =>
            raceWithHandlerTimeout(
              Promise.resolve(
                handler.invoke(record.body as never, {
                  ctx,
                  meta: {
                    ...meta,
                    idempotencyKey: meta.idempotencyKey ?? record.naturalKey,
                  },
                }),
              ),
              handlerTimeoutMs ?? 0,
            ),
        );
      }

      outcomes.push({
        meta: { ...record.meta, http: { status: 200 } },
        result: 'success',
        output,
      });
    } catch (rawError) {
      capturedError = rawError instanceof Error ? rawError : new Error(String(rawError));
      let disposition: Awaited<ReturnType<NonNullable<FunctionsHooks['onError']>>> | undefined;
      try {
        disposition = await hooks?.onError?.({
          error: capturedError,
          kind: classifyError(capturedError),
          input: record.body,
          meta: record.meta,
          trigger: adapter.kind,
          correlationId: meta.correlationId,
          isColdStart,
          ctx,
        });
      } catch (err) {
        // P-LAMBDA-2: a throwing onError must NOT silently apply a partial
        // disposition. Discard it explicitly and log structurally so the
        // record is reported as a clean failure (not falsely suppressed).
        const wrapped = err instanceof Error ? err : new Error(String(err));
        lambdaLogger.error('hook-threw', {
          hook: 'onError',
          message: wrapped.message,
          stack: wrapped.stack,
          requestId: meta.requestId,
          originalError: capturedError.message,
        });
        disposition = undefined;
      }

      if (disposition?.replaceWith) {
        capturedError = disposition.replaceWith;
      }
      const failure = capturedError ?? new Error('Invocation failed without an error instance');

      if (disposition?.suppress) {
        output = disposition.body ?? null;
        outcomes.push({
          meta: {
            ...record.meta,
            http: { status: disposition.status ?? 200, body: disposition.body },
          },
          result: 'success',
          output,
        });
      } else if (records.length > 1) {
        let recordAction: 'retry' | 'drop' = 'retry';
        try {
          recordAction =
            (await hooks?.onRecordError?.({
              record,
              error: capturedError,
              trigger: adapter.kind,
              ctx,
            })) ?? 'retry';
        } catch (err) {
          // P-LAMBDA-3: a throwing onRecordError must surface as a
          // structured error event (not a console.error line) and the
          // record stays in `retry` (the safer of the two valid actions),
          // which assembles into `result: 'error'` below — i.e. the record
          // is reported as failed, not silently dropped.
          const wrapped = err instanceof Error ? err : new Error(String(err));
          lambdaLogger.error('hook-threw', {
            hook: 'onRecordError',
            message: wrapped.message,
            stack: wrapped.stack,
            requestId: meta.requestId,
            originalError: capturedError.message,
          });
          recordAction = 'retry';
        }
        if (recordAction === 'retry') {
          outcomes.push({
            meta: {
              ...record.meta,
              http: {
                status:
                  disposition?.status ?? (failure instanceof HandlerError ? failure.status : 500),
                body:
                  disposition?.body ??
                  (failure instanceof HandlerError
                    ? { error: failure.message, code: failure.code }
                    : { error: failure.message }),
              },
            },
            result: 'error',
            error: failure,
          });
        } else {
          outcomes.push({
            meta: { ...record.meta, dropped: true },
            result: 'success',
            output: null,
          });
        }
      } else {
        outcomes.push({
          meta: {
            ...record.meta,
            http: {
              status:
                disposition?.status ?? (failure instanceof HandlerError ? failure.status : 500),
              body:
                disposition?.body ??
                (failure instanceof HandlerError
                  ? { error: failure.message, code: failure.code }
                  : { error: failure.message }),
            },
          },
          result: 'error',
          error: failure,
        });
      }
    } finally {
      try {
        await hooks?.afterInvoke?.({
          input: record.body,
          meta,
          trigger: adapter.kind,
          isColdStart,
          ctx,
          output,
          error: capturedError,
          latencyMs: Date.now() - startedAt,
        });
      } catch (err) {
        // P-LAMBDA-2: afterInvoke is observability-only — its throw must
        // not corrupt the record's outcome (already pushed to `outcomes`
        // above). Log structurally so operators can correlate.
        const wrapped = err instanceof Error ? err : new Error(String(err));
        lambdaLogger.error('hook-threw', {
          hook: 'afterInvoke',
          message: wrapped.message,
          stack: wrapped.stack,
          requestId: meta.requestId,
        });
      }
    }
  }

  if (RETRY_WHOLE_BATCH_TRIGGERS.has(adapter.kind)) {
    const failed = outcomes.find(outcome => outcome.result === 'error');
    if (failed?.error) {
      throw failed.error;
    }
  }

  return adapter.assembleResult(outcomes);
}
