/**
 * Expand a configured fallback redirect.
 *
 * @param source - Source wildcard pattern such as `/share/*`.
 * @param target - Target path template such as `/posts/:id`.
 * @param actualPath - Request path to expand.
 * @returns Expanded target path or `null` when the request does not match.
 */
export function expandFallback(source: string, target: string, actualPath: string): string | null {
  const prefix = source.slice(0, -1);
  if (!actualPath.startsWith(prefix)) return null;

  const tail = actualPath.slice(prefix.length);
  if (tail.length === 0) return null;

  return target.includes(':id') ? target.replace(':id', tail) : target;
}
