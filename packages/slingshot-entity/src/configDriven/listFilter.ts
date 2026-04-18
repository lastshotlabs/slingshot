/**
 * Normalize list filter inputs for runtime adapters.
 *
 * `buildBareEntityRoutes()` passes CRUD list scoping as
 * `{ filter: { field: value }, limit, cursor }`, while some legacy callers
 * still pass flat field filters directly on the options object. Runtime
 * adapters must honor both shapes.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the effective field filter for an adapter `list()` call.
 *
 * Precedence matches the existing memory adapter behavior:
 * - nested `opts.filter` wins when present
 * - otherwise treat non-pagination keys on `opts` as a flat filter object
 */
export function resolveListFilter(
  opts: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!opts) {
    return undefined;
  }

  const nestedFilter = opts['filter'];
  if (isRecord(nestedFilter)) {
    return nestedFilter;
  }

  const flatFilter = Object.fromEntries(
    Object.entries(opts).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'filter' &&
        key !== 'limit' &&
        key !== 'cursor' &&
        key !== 'sortDir',
    ),
  );

  return Object.keys(flatFilter).length > 0 ? flatFilter : undefined;
}
