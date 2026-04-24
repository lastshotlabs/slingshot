import type { MiddlewareHandler } from 'hono';
import type { SlingshotContext } from './slingshotContext';

const APP_CONTEXT_SYMBOL = Symbol.for('slingshot.context');
const APP_CONTEXT_MIDDLEWARE_SYMBOL = Symbol.for('slingshot.context.middleware');
const CONTEXT_BRAND_SYMBOL = Symbol.for('slingshot.context.brand');

type ContextBrandCarrier = {
  [CONTEXT_BRAND_SYMBOL]?: true;
};

export function isContextObject(value: object): value is SlingshotContext {
  return (value as ContextBrandCarrier)[CONTEXT_BRAND_SYMBOL] === true;
}

/**
 * Attach a `SlingshotContext` to a Hono app instance.
 *
 * Called once by `createApp()` after the context is fully assembled. The context is stored
 * as a non-enumerable property keyed by a well-known `Symbol` so that it does not appear
 * in object spreads or `JSON.stringify` output. When the target object exposes
 * `app.use(...)` (for example a Hono app in standalone tests), `attachContext()`
 * also installs a lightweight request middleware that seeds `c.set('slingshotCtx', ctx)`
 * so request-time helpers like `getSlingshotCtx(c)` work without the full `createApp()`
 * bootstrap.
 *
 * @param app - The Hono app (or any object) to attach the context to.
 * @param ctx - The fully initialised `SlingshotContext` instance.
 *
 * @remarks
 * **Do not call from plugin or application code.** This function is called exactly once
 * per app instance by `createApp()` after the context is fully assembled.
 *
 * Calling `attachContext` more than once on the same `app` object with different context
 * instances causes two categories of breakage, so this function now throws instead of
 * allowing a second attachment:
 *
 * 1. **Duplicate context per app** — a second call would otherwise overwrite the first
 *    context. Any code that captured a reference to the first context via `getContext(app)`
 *    would then hold stale state while request middleware could still reference the old
 *    closure.
 *
 * 2. **WeakMap collision** — framework internals that key off the app object (e.g. the
 *    `Reflect`-symbol DI table) are keyed by `app` identity. If two contexts share the
 *    same `app` reference they collide on those lookups, producing hard-to-diagnose bugs
 *    where one plugin's resolver or repo leaks into another app instance's context.
 *
 * Plugin code should always call `getContext(app)` to read the context and must never
 * attempt to create or attach one.
 *
 * @example
 * ```ts
 * import { attachContext, getContext } from '@lastshotlabs/slingshot-core';
 *
 * attachContext(app, ctx);
 * const retrieved = getContext(app); // same reference as ctx
 * ```
 */
export function attachContext(app: object, ctx: SlingshotContext): void {
  const existing = getContextOrNull(app);
  if (existing) {
    if (existing !== ctx) {
      throw new Error(
        '[slingshot] SlingshotContext is already attached to this app instance. Re-attaching a different context is not allowed.',
      );
    }
    return;
  }

  if (!isContextObject(ctx)) {
    Object.defineProperty(ctx, CONTEXT_BRAND_SYMBOL, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    });
  }

  Object.defineProperty(app, APP_CONTEXT_SYMBOL, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: ctx,
  });

  const maybeApp = app as {
    use?: (path: string, handler: MiddlewareHandler) => unknown;
  } & Record<PropertyKey, unknown>;

  if (typeof maybeApp.use === 'function' && maybeApp[APP_CONTEXT_MIDDLEWARE_SYMBOL] !== true) {
    maybeApp.use('*', async (c, next) => {
      c.set('slingshotCtx' as never, ctx as never);
      await next();
    });
    Object.defineProperty(maybeApp, APP_CONTEXT_MIDDLEWARE_SYMBOL, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    });
  }
}

/**
 * Retrieve the `SlingshotContext` for a Hono app instance.
 *
 * The context is attached by `createApp()` after all plugins have been initialised.
 * Use this in plugin `setupPost` hooks and in application code outside request handlers
 * (e.g., job workers, CLI commands, shutdown hooks).
 *
 * @param app - The Hono app instance returned by `createApp()`.
 * @returns The `SlingshotContext` attached to this app.
 * @throws If `createApp()` was not called or the context was never attached.
 *
 * @example
 * ```ts
 * import { getContext } from '@lastshotlabs/slingshot-core';
 *
 * const ctx = getContext(app);
 * const actorId = await ctx.actorResolver?.resolveActorId(req);
 * ```
 */
export function getContext(app: object): SlingshotContext {
  const ctx = (app as Record<PropertyKey, unknown>)[APP_CONTEXT_SYMBOL] as
    | SlingshotContext
    | undefined;
  if (!ctx) throw new Error('SlingshotContext not found — was createApp() called?');
  return ctx;
}

/**
 * Retrieve the `SlingshotContext` for a Hono app instance, or `null` if not attached.
 *
 * Use this when context availability is optional — for example, in standalone plugin
 * setup that may run before or without a full `createApp()` call.
 *
 * @param app - The Hono app instance.
 * @returns The `SlingshotContext`, or `null` if not yet attached.
 *
 * @example
 * ```ts
 * import { getContextOrNull } from '@lastshotlabs/slingshot-core';
 *
 * const ctx = getContextOrNull(app);
 * if (ctx) {
 *   // context available — full framework environment
 * }
 * ```
 */
export function getContextOrNull(app: object): SlingshotContext | null {
  return (
    ((app as Record<PropertyKey, unknown>)[APP_CONTEXT_SYMBOL] as SlingshotContext | undefined) ??
    null
  );
}
