import type { HandlerMeta, TriggerAdapter, TriggerRecord } from '@lastshotlabs/slingshot-core';
import { decodeHttpBody, firstString, readHeader } from '../correlation';
import { encodeHttpBody } from './_httpResponse';

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

/**
 * Extract the originating client IP from `x-forwarded-for`.
 *
 * ALB does not populate `requestContext.identity` (unlike API Gateway), so the only
 * client-IP signal available is the `x-forwarded-for` header. ALB always appends
 * the immediate downstream peer to the right; the leftmost entry is the original
 * client. Trust here is bounded by `trustProxy` policy at the framework layer —
 * this helper only does the parse.
 */
function extractAlbSourceIp(
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  const xff = readHeader(headers, 'x-forwarded-for');
  if (!xff) return undefined;
  const firstHop = xff.split(',')[0]?.trim();
  return firstHop && firstHop.length > 0 ? firstHop : undefined;
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
      ip: extractAlbSourceIp(event.headers) ?? null,
      method: event.httpMethod,
      path: event.path,
      userAgent: readHeader(event.headers, 'user-agent') ?? null,
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
    const baseStatus =
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
        statusCode: baseStatus,
        statusDescription: `${baseStatus} ${outcome?.result === 'error' ? 'Error' : 'OK'}`,
        isBase64Encoded: false,
        headers: { 'content-type': handlerContentType ?? 'application/json', ...handlerHeaders },
        body: '',
      };
    }
    const encoded = encodeHttpBody(body, { contentType: handlerContentType });
    const statusCode = encoded.failed ? encoded.statusCode : baseStatus;
    const isError = statusCode >= 400;
    const responseContentType =
      encoded.isBase64Encoded && handlerContentType
        ? handlerContentType
        : (handlerContentType ?? 'application/json');
    return {
      statusCode,
      statusDescription: `${statusCode} ${isError ? 'Error' : 'OK'}`,
      isBase64Encoded: encoded.isBase64Encoded,
      headers: { ...handlerHeaders, 'content-type': responseContentType },
      body: encoded.body,
    };
  },
};
