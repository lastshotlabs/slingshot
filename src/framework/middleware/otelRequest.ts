import { SpanStatusCode, context, propagation } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Options for the OTel request span middleware.
 */
export interface OtelRequestMiddlewareOptions {
  /** The OTel tracer instance to create request spans on. */
  tracer: Tracer;
}

/**
 * Hono middleware that creates a root span for each HTTP request.
 *
 * The span is started at the beginning of the request and ended after the
 * response is sent. Span attributes follow the OpenTelemetry HTTP semantic
 * conventions plus Slingshot-specific attributes.
 *
 * The active span is stored on the Hono context via `c.set('otelSpan', span)`
 * so that downstream middleware and plugin handlers can create child spans.
 *
 * @param options - Middleware configuration.
 * @returns A Hono `MiddlewareHandler` that wraps each request in an OTel span.
 */
export function otelRequestMiddleware(
  options: OtelRequestMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  const { tracer } = options;

  return async (c, next) => {
    // Extract propagated context from incoming headers (W3C Trace Context, B3, etc.)
    const extractedContext = propagation.extract(context.active(), c.req.raw.headers, {
      get(carrier, key) {
        return carrier.get(key) ?? undefined;
      },
      keys(carrier) {
        return [...carrier.keys()];
      },
    });

    const method = c.req.method;
    const path = c.req.path;
    const spanName = `${method} ${path}`;

    await context.with(extractedContext, async () => {
      await tracer.startActiveSpan(spanName, async (span: Span) => {
        // Set initial attributes
        span.setAttribute('http.method', method);
        span.setAttribute('http.target', path);
        span.setAttribute('http.url', c.req.url);

        // Store span on context for plugin child spans
        c.set('otelSpan', span);

        try {
          await next();

          // Set post-handler attributes
          const status = c.res.status;
          span.setAttribute('http.status_code', status);

          // Slingshot-specific attributes (available after auth middleware runs)
          const requestId = c.get('requestId');
          if (requestId) span.setAttribute('slingshot.request_id', requestId);

          const userId = c.get('authUserId');
          if (userId) span.setAttribute('slingshot.user_id', userId);

          const tenantId = c.get('tenantId');
          if (tenantId) span.setAttribute('slingshot.tenant_id', tenantId);

          if (status >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          throw err;
        } finally {
          span.end();
        }
      });
    });
  };
}
