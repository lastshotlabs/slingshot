/**
 * Schema pre-loading — extracted from `createApp()`.
 *
 * Imports shared Zod schema files before route discovery so that
 * `registerSchema` / `registerSchemas` calls execute first. This guarantees
 * that reused schemas appear as `$ref` references in the generated OpenAPI spec
 * rather than being inlined at every use site.
 *
 * Called internally by `createApp()` during startup. Plugin authors generally
 * do not need to call this directly — configure `modelSchemas` in `CreateServerConfig`
 * instead.
 */
import { maybeAutoRegister } from '@lastshotlabs/slingshot-core';
import type { RuntimeGlob } from '@lastshotlabs/slingshot-core';

/**
 * Configuration for pre-loading shared Zod schema files at app startup.
 *
 * Accepted as the `modelSchemas` option in `CreateServerConfig`. Can also be passed
 * as a bare `string` or `string[]` of directory/glob paths (shorthand for `{ paths }`)
 * when the default `'auto'` registration mode is sufficient.
 */
export interface ModelSchemasConfig {
  /**
   * One or more absolute directory paths or glob patterns containing shared Zod schemas.
   * All matching .ts files are imported before routes so schemas are registered first.
   * Optional when registration is "explicit" — in that case your registerSchema /
   * registerSchemas calls run at the time each schema file is imported by a route.
   * Examples:
   *   import.meta.dir + "/schemas"
   *   [import.meta.dir + "/schemas", import.meta.dir + "/models"]
   *   import.meta.dir + "/models/**\/*.schema.ts"
   */
  paths?: string | string[];
  /**
   * How schemas found in the files are registered in `components/schemas`.
   * - "auto" (default): exported Zod schemas are registered automatically. The export
   *   name is used as the schema name, with a trailing "Schema" suffix stripped
   *   (e.g. `LedgerItemSchema` → `"LedgerItem"`). Schemas already registered via
   *   `registerSchema` or `registerSchemas` inside the file are never overwritten.
   * - "explicit": files are imported but registration is entirely up to the user —
   *   call `registerSchema` or `registerSchemas` inside each file.
   */
  registration?: 'auto' | 'explicit';
}

type BunGlobConstructor = new (pattern: string) => {
  scan(opts: object): AsyncIterable<string>;
};

function makeBunGlob(): RuntimeGlob {
  const BunGlob = (globalThis as unknown as { Bun?: { Glob?: BunGlobConstructor } }).Bun?.Glob;
  if (!BunGlob) {
    // Fallback no-op for environments without Bun.Glob (should not happen in production)
    return { scan: async function* () {} };
  }
  return {
    async scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
      const g = new BunGlob(pattern);
      const results: string[] = [];
      for await (const f of g.scan(options ?? {})) {
        results.push(f);
      }
      return results;
    },
  };
}

/**
 * Pre-load model schema files so that shared Zod schemas are registered in
 * `components/schemas` before route handlers are discovered.
 *
 * Accepts the same value shapes as `CreateServerConfig.modelSchemas`:
 * - A single directory path or glob pattern string.
 * - An array of directory paths or glob patterns.
 * - A {@link ModelSchemasConfig} object with `paths` and a `registration` mode.
 *
 * **Registration modes:**
 * - `"auto"` (default) — after importing each file, every exported Zod schema is
 *   auto-registered via `maybeAutoRegister`. The export name is used as the schema
 *   name with a trailing `"Schema"` suffix stripped (e.g. `LedgerItemSchema` →
 *   `"LedgerItem"`). Schemas already registered explicitly are never overwritten.
 * - `"explicit"` — files are imported but registration is entirely manual.
 *   Call `registerSchema` or `registerSchemas` inside each schema file.
 *
 * Glob patterns are resolved relative to the segment before the first wildcard
 * character. Paths without wildcards are treated as directories and scanned with
 * `**\/*.ts`. Path separators are normalised to forward slashes for cross-platform
 * compatibility.
 *
 * This function is a no-op when `modelSchemas` is `undefined` or empty.
 *
 * @param modelSchemas - Schema paths config from `CreateServerConfig`. Pass `undefined`
 *   to skip pre-loading entirely.
 * @param glob - Runtime glob implementation. Defaults to a Bun-native `Bun.Glob`
 *   wrapper. Override in tests to provide a mock file list without touching the
 *   real filesystem.
 * @returns A promise that resolves once all matching files have been imported and
 *   their schemas registered.
 *
 * @example
 * ```ts
 * // In createApp() — called automatically:
 * await preloadModelSchemas(config.modelSchemas);
 *
 * // In a test — override the glob to control which files are loaded:
 * await preloadModelSchemas('/schemas', {
 *   scan: async () => ['UserSchema.ts', 'PostSchema.ts'],
 * });
 * ```
 */
export async function preloadModelSchemas(
  modelSchemas: string | string[] | ModelSchemasConfig | undefined,
  glob: RuntimeGlob = makeBunGlob(),
): Promise<void> {
  if (!modelSchemas) return;

  const { paths, registration = 'auto' } =
    typeof modelSchemas === 'string' || Array.isArray(modelSchemas)
      ? { paths: modelSchemas, registration: 'auto' as const }
      : modelSchemas;

  const pathArray = paths ? (Array.isArray(paths) ? paths : [paths]) : [];

  for (const entry of pathArray) {
    // Normalize to forward slashes so splitting works on both Windows and Unix.
    const normalized = entry.replaceAll('\\', '/');
    // Split glob patterns: everything before the first wildcard segment is the cwd.
    let cwd: string;
    let pattern: string;
    if (!normalized.includes('*')) {
      cwd = normalized;
      pattern = '**/*.ts';
    } else {
      const parts = normalized.split('/');
      const starIdx = parts.findIndex(p => p.includes('*'));
      cwd = parts.slice(0, starIdx).join('/');
      pattern = parts.slice(starIdx).join('/');
    }

    const files = await glob.scan(pattern, { cwd });
    for await (const file of files) {
      const mod: unknown = await import(`${cwd}/${file}`);
      if (registration === 'auto' && typeof mod === 'object' && mod !== null) {
        for (const [exportName, value] of Object.entries(mod)) {
          maybeAutoRegister(exportName, value);
        }
      }
      // "explicit": file imported; any registerSchema/registerSchemas calls inside already ran
    }
  }
}
