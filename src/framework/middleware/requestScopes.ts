/**
 * Request-scope lifecycle middleware.
 *
 * Mounted once per app when `defineApp({ requestScopes: [...] })` declares any
 * scopes. Installs the per-request store before the handler runs and runs
 * `cleanup` for each initialized scope after the response — even when the
 * handler throws.
 *
 * Cleanup runs in LIFO order so a transaction that depends on a connection
 * can roll back before the connection is released.
 */
import type { MiddlewareHandler } from 'hono';
import { type AppEnv, type RequestScope, setRequestScopeStore } from '@lastshotlabs/slingshot-core';

export function createRequestScopesMiddleware(
  scopes: readonly RequestScope[],
): MiddlewareHandler<AppEnv> {
  // Build a name → scope map once; the per-request store reuses it.
  const definitions = new Map<string, RequestScope>();
  for (const scope of scopes) {
    if (definitions.has(scope.name)) {
      throw new Error(
        `[slingshot] Duplicate request scope name '${scope.name}'. ` +
          `Each scope passed to defineApp({ requestScopes }) must have a unique name.`,
      );
    }
    definitions.set(scope.name, scope);
  }
  const frozenDefinitions: ReadonlyMap<string, RequestScope> = definitions;

  return async (c, next) => {
    const initialized = new Map<string, unknown>();
    setRequestScopeStore(c, { definitions: frozenDefinitions, initialized });

    try {
      await next();
    } finally {
      // Clean up in reverse order of initialization so dependent scopes
      // (e.g. a transaction that depends on a connection) tear down first.
      const entries = [...initialized.entries()].reverse();
      for (const [name, value] of entries) {
        const scope = frozenDefinitions.get(name);
        if (!scope?.cleanup) continue;
        try {
          await scope.cleanup(value as never, { request: c });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[slingshot] Request scope cleanup '${name}' threw — continuing teardown. ` +
              `Reason: ${message}`,
          );
        }
      }
    }
  };
}
