// packages/slingshot-ssr/src/actions/registry.ts
// Server action module registry — maps module path → imported module object.
// Dynamic import results are cached for the lifetime of the process. This is
// intentional: compiled action modules are build artifacts that do not change
// at runtime (Rule 3 — the cache is per-factory closure, but since dynamic
// import uses module-level caching at the engine level this is idempotent and
// acceptable for build artifact caches).

/** Module-level import cache. Keyed by resolved module path. @internal */
const moduleCache = new Map<string, Record<string, unknown>>();

/**
 * Resolve a named export from a server action module.
 *
 * Dynamically imports the module from `moduleId` (resolved at runtime via
 * `import()`) and returns the named export identified by `action`. The module
 * is cached after the first import so subsequent calls for the same module
 * are synchronous after the first await.
 *
 * Returns `null` when:
 * - The module cannot be imported (e.g. module not found)
 * - The module does not export a function named `action`
 *
 * @param moduleId - Fully-resolved module specifier or absolute file path.
 * @param action   - Named export key to retrieve from the module.
 * @returns The exported function, or `null` if not found.
 */
export async function resolveAction(
  moduleId: string,
  action: string,
): Promise<((...args: unknown[]) => unknown) | null> {
  let mod = moduleCache.get(moduleId);

  if (mod === undefined) {
    try {
      // dynamic import — no shell interpolation (Rule 11). The caller is
      // responsible for ensuring moduleId is a safe, trusted path.
      mod = (await import(moduleId)) as Record<string, unknown>;
      moduleCache.set(moduleId, mod);
    } catch {
      return null;
    }
  }

  const exported = mod[action];
  if (typeof exported !== 'function') return null;

  return exported as (...args: unknown[]) => unknown;
}

/**
 * Clear the module import cache.
 *
 * Intended for use in tests only. Calling this in production will cause all
 * subsequent action invocations to re-import their modules.
 */
export function clearActionCache(): void {
  moduleCache.clear();
}
