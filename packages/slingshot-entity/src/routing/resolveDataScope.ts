/**
 * Helpers for resolving declarative `EntityRouteConfig.dataScope` bindings.
 */
import type { Context } from 'hono';
import type {
  EntityDataScopedCrudOp,
  EntityRouteDataScopeConfig,
  EntityRouteDataScopeSource,
} from '@lastshotlabs/slingshot-core';

/**
 * Outcome of resolving the active `dataScope` entries for a CRUD operation.
 */
export type DataScopeResolution =
  | { status: 'ok'; bindings: Record<string, unknown> }
  | { status: 'missing'; source: string };

/**
 * Normalize a single dataScope entry or array of entries into an array.
 *
 * @param scope - The raw `dataScope` config value from `EntityRouteConfig`.
 * @returns A readonly array of scope entries, or an empty array when unset.
 */
export function normalizeDataScopes(
  scope: EntityRouteDataScopeConfig | readonly EntityRouteDataScopeConfig[] | undefined,
): readonly EntityRouteDataScopeConfig[] {
  if (!scope) return [];
  if (Array.isArray(scope)) return (scope as readonly EntityRouteDataScopeConfig[]).slice();
  return [scope as EntityRouteDataScopeConfig];
}

/**
 * Return only the dataScope entries that apply to the given CRUD operation.
 *
 * @param scopes - Normalized scope entries.
 * @param op - CRUD operation being handled.
 * @returns The subset of scopes that apply to the operation.
 */
export function dataScopesFor(
  scopes: readonly EntityRouteDataScopeConfig[],
  op: EntityDataScopedCrudOp,
): readonly EntityRouteDataScopeConfig[] {
  return scopes.filter(scope => !scope.applyTo || scope.applyTo.includes(op));
}

/**
 * Resolve a single `dataScope.from` binding against the Hono context.
 *
 * @param from - A `ctx:` or `param:` source string.
 * @param c - The active Hono request context.
 * @returns The resolved value, or `undefined` when the source is absent.
 */
export function resolveDataScopeValue(from: EntityRouteDataScopeSource, c: Context): unknown {
  const colon = from.indexOf(':');
  if (colon < 0) return undefined;

  const prefix = from.slice(0, colon);
  const key = from.slice(colon + 1);

  if (prefix === 'ctx') {
    const getContextValue = c.get as (name: string) => unknown;
    const value = getContextValue(key);
    return value == null ? undefined : value;
  }

  if (prefix === 'param') {
    const value = c.req.param(key);
    return value == null || value === '' ? undefined : value;
  }

  return undefined;
}

/**
 * Resolve every `dataScope` entry that applies to a CRUD operation.
 *
 * @param scopes - Normalized scope entries.
 * @param op - CRUD operation being handled.
 * @param c - The active Hono request context.
 * @returns A resolution object describing whether all bindings resolved.
 */
export function resolveDataScopes(
  scopes: readonly EntityRouteDataScopeConfig[],
  op: EntityDataScopedCrudOp,
  c: Context,
): DataScopeResolution {
  const applicable = dataScopesFor(scopes, op);
  const bindings: Record<string, unknown> = {};

  for (const scope of applicable) {
    const value = resolveDataScopeValue(scope.from, c);
    if (value === undefined) {
      return { status: 'missing', source: scope.from };
    }
    bindings[scope.field] = value;
  }

  return { status: 'ok', bindings };
}

/**
 * Find the first scoped field present in a request body.
 *
 * @param scopes - Normalized scope entries.
 * @param body - Parsed request body as a record.
 * @returns The first immutable scoped field name, or `null` when the body is clean.
 */
export function findScopedFieldInBody(
  scopes: readonly EntityRouteDataScopeConfig[],
  body: Record<string, unknown>,
): string | null {
  for (const scope of dataScopesFor(scopes, 'update')) {
    if (Object.prototype.hasOwnProperty.call(body, scope.field)) {
      return scope.field;
    }
  }
  return null;
}
