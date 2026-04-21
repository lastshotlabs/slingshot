import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { getActor, getClientIp } from '@lastshotlabs/slingshot-core';

/**
 * Severity level for a structured request log entry.
 *
 * - `"info"` — successful responses (status < 400).
 * - `"warn"` — client-error responses (status 400–499).
 * - `"error"` — server-error responses (status >= 500) or unhandled exceptions.
 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Structured log entry emitted for each HTTP request by {@link requestLogger}.
 *
 * Compatible with common structured-logging sinks (Pino, Winston, Datadog, etc.)
 * when serialised as JSON.
 */
export interface RequestLogEntry {
  /** Severity derived from the HTTP status code. */
  level: LogLevel;
  /** Unix timestamp in milliseconds (`Date.now()`) when the entry was created. */
  time: number;
  /** Human-readable summary: `"<METHOD> <path> <statusCode>"`. */
  msg: string;
  /** Server-generated request ID from the `requestId` middleware (`"unknown"` if absent). */
  requestId: string;
  /** HTTP method (e.g. `"GET"`, `"POST"`). */
  method: string;
  /** Request path without query string. */
  path: string;
  /** HTTP response status code, or `500` when an unhandled exception is caught. */
  statusCode: number;
  /** Round-trip duration in milliseconds (two decimal places). */
  responseTime: number;
  /** Resolved client IP address. */
  ip: string;
  /** `User-Agent` request header value, or `null` if absent. */
  userAgent: string | null;
  /** Resolved actor ID, or `null` if unauthenticated. */
  userId: string | null;
  /** Session ID from the resolved actor, or `null` if not set. */
  sessionId: string | null;
  /** Tenant ID from the resolved actor, or `null` in non-multi-tenant apps. */
  tenantId: string | null;
  /** OTel trace ID when distributed tracing is active, or `null` otherwise. */
  traceId: string | null;
  /** OTel span ID when distributed tracing is active, or `null` otherwise. */
  spanId: string | null;
  /** Error details when the handler threw an unhandled exception. */
  err?: { message: string; stack?: string };
}

export interface RequestLoggerOptions {
  /** Custom log handler. Default: `console.log(JSON.stringify(entry))`. */
  onLog?: (entry: RequestLogEntry) => void | Promise<void>;
  /** Minimum level to emit. Entries below this level are dropped. */
  level?: LogLevel;
  /**
   * Paths to exclude from logging. Strings use **prefix matching**
   * (`"/health"` matches `/health`, `/health/live`, `/health/ready`).
   * RegExp entries use `.test()`.
   * Default: `["/health", "/docs", "/openapi.json"]`.
   */
  excludePaths?: (string | RegExp)[];
  /** HTTP methods to exclude from logging (e.g. `["OPTIONS"]`). */
  excludeMethods?: string[];
}

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/** Convert an unknown thrown value to a human-readable string without hitting `no-base-to-string`. */
function errorToString(err: unknown): string {
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint')
    return String(err);
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

function statusToLevel(status: number): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

const DEFAULT_EXCLUDE_PATHS: (string | RegExp)[] = [
  '/health',
  '/docs',
  '/openapi.json',
  '/metrics',
];

/**
 * Hono middleware that emits a structured {@link RequestLogEntry} for every
 * non-excluded HTTP request.
 *
 * The log level is derived automatically from the response status:
 * - `"info"` for 2xx/3xx
 * - `"warn"` for 4xx
 * - `"error"` for 5xx or unhandled exceptions
 *
 * If the handler throws an unhandled error the exception is captured in
 * `entry.err`, the entry is emitted, and then the error is **re-thrown** so
 * Hono's error handler can still process it.  The `onLog` callback is always
 * called inside a try/catch — a failing logger never affects the response.
 *
 * @param options - Logger configuration.  All fields are optional.
 * @param options.onLog - Custom log sink.  Receives the completed
 *   {@link RequestLogEntry}.  Default: `console.log(JSON.stringify(entry))`.
 * @param options.level - Minimum severity to emit.  Entries below this level
 *   are silently dropped.  Omit to emit all levels.
 * @param options.excludePaths - Paths to skip.  Strings use prefix matching;
 *   RegExp entries use `.test()`.  Default:
 *   `["/health", "/docs", "/openapi.json", "/metrics"]`.
 * @param options.excludeMethods - HTTP methods to skip entirely (e.g.
 *   `["OPTIONS"]`).
 * @returns A Hono `MiddlewareHandler` that emits one log entry per request.
 *
 * @example
 * ```ts
 * app.use(requestLogger({
 *   level: 'warn',
 *   excludePaths: ['/health'],
 *   onLog: entry => myLogger.log(entry),
 * }));
 * ```
 */
export const requestLogger = (options: RequestLoggerOptions = {}): MiddlewareHandler<AppEnv> => {
  const {
    onLog = (entry: RequestLogEntry) => console.log(JSON.stringify(entry)),
    level: minLevel,
    excludePaths = DEFAULT_EXCLUDE_PATHS,
    excludeMethods,
  } = options;

  return async (c, next) => {
    const method = c.req.method;
    if (excludeMethods?.includes(method)) {
      return next();
    }

    const path = c.req.path;
    const excluded = excludePaths.some(p =>
      typeof p === 'string' ? path.startsWith(p) : p.test(path),
    );
    if (excluded) {
      return next();
    }

    const start = performance.now();
    let error: unknown;

    try {
      await next();
    } catch (e) {
      error = e;
    }

    const statusCode = error ? 500 : c.res.status;
    const level = statusToLevel(statusCode);

    if (minLevel && LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
      if (error) throw error instanceof Error ? error : new Error(errorToString(error));
      return;
    }

    const otelSpan = c.get('otelSpan');
    const spanContext = otelSpan?.spanContext();
    const actor = getActor(c);

    const entry: RequestLogEntry = {
      level,
      time: Date.now(),
      msg: `${method} ${path} ${error ? 'ERROR' : statusCode}`,
      requestId: c.get('requestId'),
      method,
      path,
      statusCode,
      responseTime: Math.round((performance.now() - start) * 100) / 100,
      ip: getClientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
      userId: actor.id,
      sessionId: actor.sessionId,
      tenantId: actor.tenantId,
      traceId: spanContext?.traceId ?? null,
      spanId: spanContext?.spanId ?? null,
    };

    if (error) {
      entry.err = {
        message: error instanceof Error ? error.message : errorToString(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
    }

    try {
      void onLog(entry);
    } catch {
      // onLog error isolation — never affect the response
    }

    if (error) throw error instanceof Error ? error : new Error(errorToString(error));
  };
};
