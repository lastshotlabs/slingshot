// packages/slingshot-ssr-tanstack/src/scanner.ts
//
// Scan a TanStack routes directory and build a flat catalog of route entries.
// Each entry knows its URL pattern, file path, the (optional) companion server
// file path, and (when present) the layout chain.
//
// Companion-file convention (mirrors Remix's `.server.ts` pattern):
//   `<route>.tsx` is the canonical TanStack route file (component + Route).
//   `<route>.server.ts` (or `.server.tsx`) holds the SSR-only `load` + `meta`
//     exports. The file is stripped from the client bundle by the Vite plugin
//     in this package; importing it from client code is a build error.
//
// Routes with no companion file are CSR-only — the SSR route source returns
// `null` for their URLs, and the SPA fallback serves them.
//
// Discovery process:
//   1. Recursively read the directory; ignore `*.server.{ts,tsx}` files (they
//      are companions, not standalone routes — picked up alongside their
//      partner).
//   2. For each `.tsx` / `.ts` file, derive a TanStack URL pattern from its
//      relative path (delegated to `pathSyntax.ts`).
//   3. Identify pathless layout files (`_pathless.tsx`) and the root layout
//      (`__root.tsx`) for use in chain construction.
//   4. For each candidate route file, look for a sibling companion file with
//      the same base name and a `.server.{ts,tsx}` suffix. Record its absolute
//      path (or null when absent).
import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { type TranslatedPath, translatePath } from './pathSyntax';

/** A scanned route file before SSR-companion detection. */
export interface ScannedRouteFile {
  /** Absolute path to the route file. */
  readonly filePath: string;
  /** Absolute path to the sibling `.server.{ts,tsx}` companion, or null. */
  readonly serverFilePath: string | null;
  /** Relative path from the routes directory, without extension, forward-slash. */
  readonly relativePath: string;
  /** Translated URL info — undefined for pure layout files (handled separately). */
  readonly translation: TranslatedPath;
}

// Phase 2c removed `ScannedRouteEntry` — layout chain is now expressed via
// `LayoutEntry[]` and attached at the source level (TanStackRouteEntry in
// source.ts). Keeping a type alias for backwards compatibility within the
// package — adapter authors should rely on `ScannedRouteFile` + `LayoutEntry`.

const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts']);

/**
 * Scan a TanStack routes directory and return all candidate route files plus
 * the layout-file index. Each route's `serverFilePath` is the absolute path of
 * its companion `.server.{ts,tsx}` file, or `null` when none exists.
 */
export function scanRoutesDirectory(routesDirectory: string): {
  readonly leaves: readonly ScannedRouteFile[];
  /** layout file path keyed by directory key (e.g. `_app`, `_app/_feed`). */
  readonly layouts: ReadonlyMap<
    string,
    { readonly filePath: string; readonly serverFilePath: string | null }
  >;
  readonly rootLayoutPath: string | null;
  readonly rootLayoutServerPath: string | null;
} {
  const allFiles = collectFiles(routesDirectory);

  // Index of every absolute file path we discovered — lets us O(1)-check
  // whether a given companion exists without re-touching the filesystem.
  const filesByPath = new Set(allFiles);

  const layouts = new Map<string, { filePath: string; serverFilePath: string | null }>();
  let rootLayoutPath: string | null = null;
  let rootLayoutServerPath: string | null = null;
  const leaves: ScannedRouteFile[] = [];

  for (const filePath of allFiles) {
    const rel = relative(routesDirectory, filePath).split(sep).join('/');
    const ext = extname(rel);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    const noExt = rel.slice(0, -ext.length);

    // Companion files (`<route>.server.{ts,tsx}`) are picked up alongside
    // their partner; skip them as standalone routes.
    if (isServerCompanionStem(noExt)) continue;

    const serverFilePath = findCompanion(filesByPath, filePath, ext);

    if (noExt === '__root') {
      rootLayoutPath = filePath;
      rootLayoutServerPath = serverFilePath;
      continue;
    }

    // A pathless file is one whose final segment starts with `_` (but not
    // `__`). Pathless files at any level act as layouts for the directory of
    // the same base name (e.g. `_app.tsx` is the layout for everything under
    // `_app/`).
    const finalSegment = lastSegment(noExt);
    if (finalSegment.startsWith('_') && !finalSegment.startsWith('__')) {
      const directoryKey = noExt; // `_app/_feed` → layout for `_app/_feed/...`
      layouts.set(directoryKey, { filePath, serverFilePath });
      continue;
    }

    let translation: TranslatedPath;
    try {
      translation = translatePath(noExt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[slingshot-ssr-tanstack] failed to translate route '${rel}': ${message}`, {
        cause: err,
      });
    }

    if (translation.isRoot) continue;

    leaves.push(
      Object.freeze({
        filePath,
        serverFilePath,
        relativePath: noExt,
        translation,
      }),
    );
  }

  return {
    leaves: Object.freeze(
      [...leaves].sort((a, b) => {
        const specA = specificity(a.translation.urlPattern);
        const specB = specificity(b.translation.urlPattern);
        if (specA !== specB) return specB - specA;
        return a.relativePath.localeCompare(b.relativePath);
      }),
    ),
    layouts,
    rootLayoutPath,
    rootLayoutServerPath,
  };
}

/**
 * `<route>.server.ts` and `<route>.server.tsx` are companion files. Detect via
 * the final dot-separated suffix `.server`.
 */
function isServerCompanionStem(noExt: string): boolean {
  return noExt.endsWith('.server');
}

/**
 * Look for `<filePath without ext>.server.{ts,tsx}` as a sibling. Returns the
 * absolute path of the first match, preferring `.server.ts` when both exist
 * (deterministic precedence).
 */
function findCompanion(files: ReadonlySet<string>, filePath: string, ext: string): string | null {
  const stem = filePath.slice(0, -ext.length);
  const tsCompanion = `${stem}.server.ts`;
  if (files.has(tsCompanion)) return tsCompanion;
  const tsxCompanion = `${stem}.server.tsx`;
  if (files.has(tsxCompanion)) return tsxCompanion;
  return null;
}

/**
 * For a given leaf route, return the layout chain — each entry is a
 * `{ filePath, serverFilePath }` pair, ordered outermost-first. Walks pathless
 * ancestors and includes `__root` when present.
 *
 * Example: leaf at `_app/_feed/index.tsx` →
 *   [{ filePath: '__root.tsx', serverFilePath: ... },
 *    { filePath: '_app.tsx',   serverFilePath: ... },
 *    { filePath: '_app/_feed.tsx', serverFilePath: ... }]
 */
export interface LayoutEntry {
  readonly filePath: string;
  readonly serverFilePath: string | null;
}

export function buildLayoutChain(
  leaf: ScannedRouteFile,
  layouts: ReadonlyMap<string, { filePath: string; serverFilePath: string | null }>,
  rootLayoutPath: string | null,
  rootLayoutServerPath: string | null,
): readonly LayoutEntry[] {
  const chain: LayoutEntry[] = [];
  if (rootLayoutPath !== null) {
    chain.push({ filePath: rootLayoutPath, serverFilePath: rootLayoutServerPath });
  }

  let progressive = '';
  for (const ancestor of leaf.translation.pathlessAncestors) {
    progressive = progressive === '' ? ancestor : `${progressive}/${ancestor}`;
    const layout = layouts.get(progressive);
    if (layout !== undefined) chain.push(layout);
  }
  return Object.freeze(chain);
}

/**
 * Recursively walk a directory, returning absolute file paths. Symlinks not
 * followed.
 */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (stats.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function lastSegment(relativeNoExt: string): string {
  const slash = relativeNoExt.lastIndexOf('/');
  const tail = slash === -1 ? relativeNoExt : relativeNoExt.slice(slash + 1);
  // For flat-format files (e.g. `user.$handle`), the LAST dot-separated piece
  // is the leaf for layout-detection purposes — but a flat-format file is
  // never itself a layout (layouts are always `_xxx.tsx` with no dots). So
  // returning the whole tail string is the right call: if the tail starts
  // with `_`, it's a layout; otherwise it's a leaf.
  return tail;
}

function specificity(pattern: string): number {
  // Higher = more specific. Static segments score; param segments don't.
  if (pattern === '/') return 1;
  let score = 0;
  for (const seg of pattern.split('/')) {
    if (seg.length === 0) continue;
    if (seg.startsWith(':')) continue;
    score += 100;
  }
  return score;
}
