/**
 * A request handler — the innermost function in a middleware chain.
 *
 * Receives a standard `Request` and returns (or resolves to) a `Response`.
 * Used as the terminal handler passed to {@link applyMiddleware}.
 */
export type Handler = (req: Request) => Response | Promise<Response>;

/**
 * A composable middleware function for the raw `Request`/`Response` pipeline.
 *
 * Wraps a {@link Handler} and can intercept, transform, or short-circuit the
 * request before or after calling `next`.  Unlike Hono middleware, this type
 * operates on plain `Request`/`Response` objects and has no access to Hono's
 * context.  Suitable for lightweight, framework-agnostic wrapping.
 */
export type Middleware = (req: Request, next: Handler) => Response | Promise<Response>;

/**
 * Compose an ordered middleware stack around a base handler.
 *
 * Middleware is applied right-to-left so that the first element in the
 * `middleware` array is the **outermost** wrapper — i.e. the first to run on
 * a request and the last to observe the response.
 *
 * @param handler - The inner handler that ultimately produces the `Response`.
 * @param middleware - Zero or more middleware functions to wrap around `handler`.
 * @returns A new `Handler` that runs through the full middleware chain before
 *   delegating to `handler`.
 */
export const applyMiddleware = (handler: Handler, ...middleware: Middleware[]): Handler => {
  let next = handler;
  for (const mw of middleware.toReversed()) {
    const current = next;
    next = req => mw(req, current);
  }
  return next;
};
