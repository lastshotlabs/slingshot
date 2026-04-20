import {
  HandlerError,
  ValidationError,
  type FunctionsHooks,
  type HandlerMeta,
  type RecordOutcome,
  type SlingshotContext,
  type SlingshotHandler,
  type TriggerAdapter,
  type TriggerOpts,
  type TriggerRecord,
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
  lambdaContext?: LambdaContextLike,
): HandlerMeta {
  const extracted = adapter.extractMeta(event, record);
  const requestId = extracted.requestId ?? lambdaContext?.awsRequestId ?? crypto.randomUUID();
  return {
    requestId,
    tenantId: extracted.tenantId ?? null,
    authUserId: extracted.authUserId ?? null,
    correlationId: extracted.correlationId ?? requestId,
    ip: extracted.ip ?? null,
    authClientId: extracted.authClientId ?? null,
    bearerClientId: extracted.bearerClientId ?? null,
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
    const meta = buildMeta(adapter, event, record, lambdaContext);
    const startedAt = Date.now();
    let output: unknown;
    let capturedError: Error | undefined;

    try {
      const aborted = await hooks?.beforeInvoke?.({
        input: record.body,
        meta,
        trigger: adapter.kind,
        isColdStart,
        ctx,
      });
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
      const disposition = await hooks?.onError?.({
        error: capturedError,
        kind: classifyError(capturedError),
        input: record.body,
        meta: record.meta,
        trigger: adapter.kind,
        correlationId: meta.correlationId,
        isColdStart,
        ctx,
      });

      if (disposition?.replaceWith) {
        capturedError = disposition.replaceWith;
      }
      const error = capturedError;

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
                status: disposition?.status ?? (error instanceof HandlerError ? error.status : 500),
                body:
                  disposition?.body ??
                  (error instanceof HandlerError
                    ? { error: error.message, code: error.code }
                    : { error: error.message }),
              },
            },
            result: 'error',
            error,
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
              status: disposition?.status ?? (error instanceof HandlerError ? error.status : 500),
              body:
                disposition?.body ??
                (error instanceof HandlerError
                  ? { error: error.message, code: error.code }
                  : { error: error.message }),
            },
          },
          result: 'error',
          error,
        });
      }
    } finally {
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
