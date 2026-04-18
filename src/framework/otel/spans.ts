import { type Span, SpanStatusCode, type Tracer, context, trace } from '@opentelemetry/api';
import type { Context as HonoContext } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Execute an async function within an OTel span.
 *
 * The span is started before `fn` runs, and ended after `fn` resolves or
 * rejects. On rejection the span status is set to ERROR and the exception
 * is recorded on the span before re-throwing.
 *
 * @param tracer - The OTel tracer to create the span on.
 * @param name - Span name (e.g. `'slingshot.bootstrap.secrets'`).
 * @param fn - The async function to execute within the span. Receives the
 *   active span as its argument for setting attributes.
 * @returns The resolved value of `fn`.
 * @throws Re-throws any error from `fn` after recording it on the span.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async span => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
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
}

/**
 * Execute a synchronous function within an OTel span.
 *
 * Same semantics as `withSpan` but for synchronous work.
 *
 * @param tracer - The OTel tracer to create the span on.
 * @param name - Span name (e.g. `'slingshot.bootstrap.validate'`).
 * @param fn - The synchronous function to execute within the span. Receives
 *   the active span as its argument for setting attributes.
 * @returns The return value of `fn`.
 * @throws Re-throws any error from `fn` after recording it on the span.
 */
export function withSpanSync<T>(tracer: Tracer, name: string, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, span => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
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
}

/**
 * Create a child span within the current request's trace context.
 *
 * Returns `undefined` when tracing is not active on this request. Plugin
 * authors should guard on the return value:
 *
 * ```ts
 * const span = createChildSpan(c, 'my-plugin.heavy-computation');
 * try {
 *   // ... do work ...
 * } finally {
 *   span?.end();
 * }
 * ```
 *
 * @param c - The Hono context for the current request.
 * @param name - The span name.
 * @returns The started child span, or `undefined` when tracing is not active.
 */
export function createChildSpan(c: HonoContext<AppEnv>, name: string): Span | undefined {
  const parentSpan = c.get('otelSpan');
  if (!parentSpan) return undefined;

  const parentContext = trace.setSpan(context.active(), parentSpan);
  const tracer = trace.getTracer('@lastshotlabs/slingshot');
  return tracer.startSpan(name, {}, parentContext);
}
