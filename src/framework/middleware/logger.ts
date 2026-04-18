import type { Middleware } from '.';

/**
 * Minimal request/response logger for the raw `Request`/`Response` pipeline.
 *
 * Logs a single line per request in the format:
 * `<METHOD> <pathname> <status> <duration>ms`
 *
 * Intended for lightweight, framework-agnostic use via {@link applyMiddleware}.
 * For Hono-integrated logging (with request IDs, tenant context, and structured
 * JSON output) prefer the `requestLogger` middleware instead.
 */
export const logger: Middleware = async (req, next) => {
  const start = performance.now();
  const res = await next(req);
  const ms = (performance.now() - start).toFixed(2);
  console.log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${ms}ms`);
  return res;
};
