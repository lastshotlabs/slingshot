/**
 * Returns whether a request path matches any declared public-path pattern.
 *
 * Supported pattern forms:
 * - exact path: `/.well-known/assetlinks.json`
 * - prefix wildcard: `/.well-known/*`
 *
 * @param path - Request path to check.
 * @param publicPaths - Declared public-path patterns. When omitted, no paths
 *   are treated as public.
 * @returns `true` when the path matches an exact pattern or a `*`-suffix prefix.
 *
 * @example
 * ```ts
 * isPublicPath('/.well-known/apple-app-site-association', new Set(['/.well-known/*']));
 * // true
 * ```
 */
export function isPublicPath(path: string, publicPaths?: Iterable<string> | null): boolean {
  if (!publicPaths) return false;

  for (const pattern of publicPaths) {
    if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
      continue;
    }

    if (path === pattern) return true;
  }

  return false;
}
