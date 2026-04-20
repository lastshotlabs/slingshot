import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';
import { decodeHttpBody, firstString, readHeader } from '../correlation';

type ApiGatewayV2Event = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: { method?: string; path?: string; sourceIp?: string; userAgent?: string };
  };
};

function parseBody(event: ApiGatewayV2Event): unknown {
  return decodeHttpBody(event.body, event.isBase64Encoded);
}

export const apigwV2Trigger: TriggerAdapter<ApiGatewayV2Event, Record<string, unknown>> = {
  kind: 'apigw-v2',
  extractInputs(event): TriggerRecord[] {
    const parsedBody = parseBody(event);
    return [
      {
        body: {
          ...(event.queryStringParameters ?? {}),
          ...(typeof parsedBody === 'object' && parsedBody !== null
            ? (parsedBody as Record<string, unknown>)
            : { body: parsedBody }),
          ...(event.pathParameters ?? {}),
        },
        meta: {
          headers: event.headers ?? {},
          method: event.requestContext?.http?.method,
          path: event.requestContext?.http?.path,
        },
        naturalKey: readHeader(event.headers, 'idempotency-key') ?? undefined,
      },
    ];
  },
  extractMeta(event): Partial<HandlerMeta> {
    return {
      requestId: event.requestContext?.requestId,
      correlationId: firstString(
        readHeader(event.headers, 'x-correlation-id'),
        readHeader(event.headers, 'x-request-id'),
        event.requestContext?.requestId,
      ) ?? undefined,
      ip: event.requestContext?.http?.sourceIp ?? null,
      method: event.requestContext?.http?.method,
      path: event.requestContext?.http?.path,
      userAgent: event.requestContext?.http?.userAgent ?? null,
      idempotencyKey: readHeader(event.headers, 'idempotency-key') ?? undefined,
    };
  },
  assembleResult(outcomes): Record<string, unknown> {
    const outcome = outcomes[0];
    const httpMeta = (outcome?.meta.http ?? {}) as { status?: number; body?: unknown };
    const statusCode =
      outcome?.result === 'error'
        ? (httpMeta.status ?? 500)
        : (httpMeta.status ?? 200);
    const body =
      outcome?.result === 'error'
        ? (httpMeta.body ?? { error: outcome.error?.message ?? 'Internal Server Error' })
        : (outcome?.output ?? httpMeta.body ?? null);
    return {
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: body === null ? '' : JSON.stringify(body),
      isBase64Encoded: false,
    };
  },
};
