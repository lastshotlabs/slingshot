import type { HandlerMeta, TriggerAdapter, TriggerRecord } from '@lastshotlabs/slingshot-core';
import { decodeHttpBody, firstString, readHeader } from '../correlation';
import { safeStringify } from './_httpResponse';

type AlbEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  path?: string;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  requestContext?: { elb?: { targetGroupArn?: string } };
};

function parseBody(event: AlbEvent): unknown {
  return decodeHttpBody(event.body, event.isBase64Encoded);
}

export const albTrigger: TriggerAdapter<AlbEvent, Record<string, unknown>> = {
  kind: 'alb',
  extractInputs(event): TriggerRecord[] {
    const parsedBody = parseBody(event);
    return [
      {
        body: {
          ...(event.queryStringParameters ?? {}),
          ...(typeof parsedBody === 'object' && parsedBody !== null
            ? (parsedBody as Record<string, unknown>)
            : { body: parsedBody }),
        },
        meta: { headers: event.headers ?? {}, method: event.httpMethod, path: event.path },
        naturalKey: readHeader(event.headers, 'idempotency-key') ?? undefined,
      },
    ];
  },
  extractMeta(event): Partial<HandlerMeta> {
    return {
      requestId: event.requestContext?.elb?.targetGroupArn,
      correlationId:
        firstString(
          readHeader(event.headers, 'x-correlation-id'),
          readHeader(event.headers, 'x-request-id'),
          event.requestContext?.elb?.targetGroupArn,
        ) ?? undefined,
      method: event.httpMethod,
      path: event.path,
      idempotencyKey: readHeader(event.headers, 'idempotency-key') ?? undefined,
    };
  },
  assembleResult(outcomes): Record<string, unknown> {
    const outcome = outcomes[0];
    const httpMeta = (outcome?.meta.http ?? {}) as { status?: number; body?: unknown };
    const baseStatus =
      outcome?.result === 'error' ? (httpMeta.status ?? 500) : (httpMeta.status ?? 200);
    const body =
      outcome?.result === 'error'
        ? (httpMeta.body ?? { error: outcome.error?.message ?? 'Internal Server Error' })
        : (outcome?.output ?? httpMeta.body ?? null);
    if (body === null) {
      return {
        statusCode: baseStatus,
        statusDescription: `${baseStatus} ${outcome?.result === 'error' ? 'Error' : 'OK'}`,
        isBase64Encoded: false,
        headers: { 'content-type': 'application/json' },
        body: '',
      };
    }
    const serialized = safeStringify(body);
    const statusCode = serialized.failed ? serialized.statusCode : baseStatus;
    const isError = statusCode >= 400;
    return {
      statusCode,
      statusDescription: `${statusCode} ${isError ? 'Error' : 'OK'}`,
      isBase64Encoded: false,
      headers: { 'content-type': 'application/json' },
      body: serialized.body,
    };
  },
};
