// packages/slingshot-ssr-tanstack/src/pathSyntax.ts
//
// Translate TanStack Router file-naming conventions to URL patterns and a
// regex matcher.
//
// TanStack conventions supported in v1:
//   - Directories contribute path segments unless they start with `_` (pathless).
//   - `_pathless.tsx` files (any file starting with `_` other than `__root`) are
//     layout files for the directory of the same base name. They do not
//     contribute to the URL.
//   - `__root.tsx` is the global root layout. It does not contribute to the URL.
//   - `index.tsx` matches the parent directory path exactly (empty segment).
//   - `$param.tsx` is a dynamic segment: `:param`.
//   - Dots in a filename act as path separators in flat-format files
//     (`user.$handle.tsx` → `/user/:handle`).
//
// Out of scope (v1):
//   - `$.tsx` splat / catch-all (throws on encounter — punted to a follow-up)
//   - TanStack's search-param schemas
//   - Path-prefix groups via `(group)` syntax (TanStack does not currently
//     support this; included as a TODO if/when it lands)

/** A single segment in a file path, after splitting on `/` and `.`. */
interface SegmentToken {
  /** The raw token as it appears in the filename. */
  readonly raw: string;
  /** The kind of segment. */
  readonly kind: 'literal' | 'param' | 'pathless' | 'index' | 'root';
  /** Param name when `kind === 'param'`, otherwise null. */
  readonly paramName: string | null;
}

/** Result of translating a route file's relative path. */
export interface TranslatedPath {
  /** URL pattern with `:param` placeholders, e.g. `/c/:slug/:threadId`. */
  readonly urlPattern: string;
  /** Compiled regex that matches a request pathname against `urlPattern`. */
  readonly regex: RegExp;
  /** Param names in declaration order. */
  readonly paramNames: readonly string[];
  /**
   * The directory segments (URL-contributing only — pathless ancestors
   * stripped). Ordered outermost-first. Used to identify layout owners.
   */
  readonly directorySegments: readonly string[];
  /**
   * The full ordered list of pathless ancestor segment names, outermost-first.
   * E.g. for `_app/_feed/index.tsx` → `['_app', '_feed']`. Used by the layout
   * resolver to find `_app.tsx`, `_app/_feed.tsx`, etc.
   */
  readonly pathlessAncestors: readonly string[];
  /** Whether this path is the root layout file (`__root.tsx`). */
  readonly isRoot: boolean;
}

/**
 * Translate a route-file path (relative to the routes directory, without
 * extension) to its URL pattern + regex matcher.
 *
 * @param relativePath - Forward-slash separated path with no extension.
 *   Examples: `__root`, `_app`, `_app/_feed/index`, `_app/dm/$userId`,
 *   `_app/user.$handle`, `_guest/auth/login`.
 * @throws When the path uses syntax not yet supported (e.g. `$` splat).
 */
export function translatePath(relativePath: string): TranslatedPath {
  if (relativePath === '__root') {
    return Object.freeze({
      urlPattern: '',
      regex: /(?:)/,
      paramNames: [],
      directorySegments: [],
      pathlessAncestors: [],
      isRoot: true,
    });
  }

  // Split on `/` (directory boundaries) AND `.` (flat-format separators).
  // Preserve order; `.` and `/` produce the same segment-token sequence.
  const rawSegments: string[] = relativePath.split('/').flatMap(part => part.split('.'));

  const tokens: SegmentToken[] = rawSegments.map(parseSegment);

  // The pathless-ancestors list mirrors the directory-only walk. Recompute
  // from the original `/`-split (so dot-separated suffixes don't pollute it).
  const dirParts = relativePath.split('/');
  const pathlessAncestors: string[] = [];
  for (let i = 0; i < dirParts.length - 1; i++) {
    const part = dirParts[i];
    if (part === undefined) continue;
    if (part.startsWith('_') && !part.startsWith('__')) {
      pathlessAncestors.push(part);
    }
  }

  // Build the URL pattern. Pathless segments contribute nothing. `index`
  // contributes nothing (matches parent exactly). Param segments become
  // `:name`. Literal segments are URL-encoded literals.
  const urlSegments: string[] = [];
  const directorySegments: string[] = [];
  const paramNames: string[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case 'pathless':
        // Layout-only; skip from URL.
        break;
      case 'index':
        // Parent-exact; skip from URL.
        break;
      case 'param': {
        const name = token.paramName;
        if (name === null) {
          throw new Error(
            `[slingshot-ssr-tanstack] internal: param token missing paramName for '${token.raw}'`,
          );
        }
        urlSegments.push(`:${name}`);
        directorySegments.push(token.raw);
        paramNames.push(name);
        break;
      }
      case 'literal':
        urlSegments.push(token.raw);
        directorySegments.push(token.raw);
        break;
      case 'root':
        // Already handled at the top — should not reach here for non-root paths.
        break;
    }
  }

  const urlPattern = urlSegments.length === 0 ? '/' : '/' + urlSegments.join('/');
  const regex = compileRegex(urlPattern, paramNames);

  return Object.freeze({
    urlPattern,
    regex,
    paramNames: Object.freeze(paramNames),
    directorySegments: Object.freeze(directorySegments),
    pathlessAncestors: Object.freeze(pathlessAncestors),
    isRoot: false,
  });
}

function parseSegment(raw: string): SegmentToken {
  if (raw === '__root') {
    return { raw, kind: 'root', paramName: null };
  }
  if (raw === 'index') {
    return { raw, kind: 'index', paramName: null };
  }
  if (raw.startsWith('_')) {
    return { raw, kind: 'pathless', paramName: null };
  }
  if (raw === '$') {
    throw new Error(
      `[slingshot-ssr-tanstack] catch-all '$' route segments are not yet supported in v1. ` +
        `Migrate the route to a typed param or rebuild without splat.`,
    );
  }
  if (raw.startsWith('$')) {
    const paramName = raw.slice(1);
    if (paramName.length === 0) {
      throw new Error(
        `[slingshot-ssr-tanstack] empty param name in '${raw}'. ` +
          `Use $name (e.g. $slug) for dynamic segments.`,
      );
    }
    return { raw, kind: 'param', paramName };
  }
  return { raw, kind: 'literal', paramName: null };
}

function compileRegex(urlPattern: string, paramNames: readonly string[]): RegExp {
  // Replace `:name` with a named capture group matching one path segment.
  let body = urlPattern;
  for (const name of paramNames) {
    body = body.replace(`:${name}`, `(?<${name}>[^/]+)`);
  }
  // Escape any regex-special characters in literal portions — TanStack
  // filenames cannot contain regex metacharacters legally, but be defensive.
  // Conservative: replace only `.` (the legitimate special char that COULD
  // appear after we've consumed dot-separators above).
  body = body.replace(/\./g, '\\.');
  return new RegExp(`^${body}$`);
}
