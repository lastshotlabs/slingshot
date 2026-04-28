import type { HandlerMeta, TriggerAdapter, TriggerRecord } from '@lastshotlabs/slingshot-core';
import { decodeHttpBody, firstString, readHeader } from '../correlation';
import { encodeHttpBody } from './_httpResponse';

type ApiGatewayV1Event = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  requestContext?: { requestId?: string; identity?: { sourceIp?: string; userAgent?: string } };
  httpMethod?: string;
  path?: string;
  isBase64Encoded?: boolean;
};

function parseBody(event: ApiGatewayV1Event): unknown {
  return decodeHttpBody(event.body, event.isBase64Encoded);
}

export const apigwTrigger: TriggerAdapter<ApiGatewayV1Event, Record<string, unknown>> = {
  kind: 'apigw',
  extractInputs(event): TriggerRecord[] {
    return [
      {
        body: {
          ...(event.queryStringParameters ?? {}),
          ...(typeof parseBody(event) === 'object' && parseBody(event) !== null
            ? (parseBody(event) as Record<string, unknown>)
            : { body: parseBody(event) }),
          ...(event.pathParameters ?? {}),
        },
        meta: {
          headers: event.headers ?? {},
          method: event.httpMethod,
          path: event.path,
        },
        naturalKey: readHeader(event.headers, 'idempotency-key') ?? undefined,
      },
    ];
  },
  extractMeta(event): Partial<HandlerMeta> {
    return {
      requestId: event.requestContext?.requestId,
      correlationId:
        firstString(
          readHeader(event.headers, 'x-correlation-id'),
          readHeader(event.headers, 'x-request-id'),
          event.requestContext?.requestId,
        ) ?? undefined,
      ip: event.requestContext?.identity?.sourceIp ?? null,
      method: event.httpMethod,
      path: event.path,
      userAgent: event.requestContext?.identity?.userAgent ?? null,
      idempotencyKey: readHeader(event.headers, 'idempotency-key') ?? undefined,
    };
  },
  assembleResult(outcomes): Record<string, unknown> {
    const outcome = outcomes[0];
    const httpMeta = (outcome?.meta.http ?? {}) as {
      status?: number;
      body?: unknown;
      headers?: Record<string, string>;
    };
    const statusCode =
      outcome?.result === 'error' ? (httpMeta.status ?? 500) : (httpMeta.status ?? 200);
    const body =
      outcome?.result === 'error'
        ? (httpMeta.body ?? { error: outcome.error?.message ?? 'Internal Server Error' })
        : (outcome?.output ?? httpMeta.body ?? null);
    const handlerHeaders = httpMeta.headers ?? {};
    const handlerContentType =
      handlerHeaders['content-type'] ?? handlerHeaders['Content-Type'] ?? undefined;
    if (body === null) {
      return {
        statusCode,
        headers: { ...handlerHeaders, 'content-type': handlerContentType ?? 'application/json' },
        body: '',
        isBase64Encoded: false,
      };
    }
    const encoded = encodeHttpBody(body, { contentType: handlerContentType });
    const responseContentType =
      encoded.isBase64Encoded && handlerContentType
        ? handlerContentType
        : (handlerContentType ?? 'application/json');
    return {
      statusCode: encoded.failed ? encoded.statusCode : statusCode,
      headers: { ...handlerHeaders, 'content-type': responseContentType },
      body: encoded.body,
      isBase64Encoded: encoded.isBase64Encoded,
    };
  },
};
