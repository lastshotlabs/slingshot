import {
  ANONYMOUS_ACTOR,
  type FunctionsHooks,
  HandlerError,
  type HandlerMeta,
  type IdentityResolver,
  type RecordOutcome,
  type SlingshotContext,
  type SlingshotHandler,
  type TriggerAdapter,
  type TriggerOpts,
  type TriggerRecord,
  ValidationError,
} from '@lastshotlabs/slingshot-core';
import { invokeWithRecordIdempotency } from './idempotency';

const RETRY_WHOLE_BATCH_TRIGGERS = new Set(['msk', 'kinesis', 'dynamodb-streams']);
const AUTO_IDEMPOTENT_TRIGGERS = new Set(['sqs', 'msk', 'kinesis', 'dynamodb-streams']);

type LambdaContextLike = {
  awsRequestId?: string;
};

function classifyError(error: Error): 'validation' | 'handler' | 'idempotency' | 'unknown' {
  if (error instanceof ValidationError) return 'validation';
  if (error instanceof HandlerError) return 'handler';
  if (error.message.toLowerCase().includes('idempotency')) return 'idempotency';
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
      try {
        aborted = await hooks?.beforeInvoke?.({
          input: record.body,
          meta,
          trigger: adapter.kind,
          isColdStart,
          ctx,
        });
      } catch (err) {
        console.error('[lambda] beforeInvoke hook threw:', err);
      }
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
            handler.invoke(record.body as never, {
              ctx,
              meta: {
                ...meta,
                idempotencyKey: meta.idempotencyKey ?? record.naturalKey,
              },
            }),
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
        console.error('[lambda] onError hook threw:', err);
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
        const recordAction =
          (await hooks?.onRecordError?.({
            record,
            error: capturedError,
            trigger: adapter.kind,
            ctx,
          })) ?? 'retry';
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
        console.error('[lambda] afterInvoke hook threw:', err);
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
