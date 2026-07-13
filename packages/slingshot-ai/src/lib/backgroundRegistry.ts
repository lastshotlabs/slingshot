/**
 * Which schema names a background generation task knows how to produce.
 *
 * This exists to solve a small but real coordination problem. The task is built
 * in `src/orchestration.ts` (a separate entry point, so the main entry never
 * pulls in the orchestration engine), while the decision to *queue* a call is
 * made in `plugin.ts`. The plugin therefore has to know which schemas the task
 * registered — without importing the module that knows.
 *
 * A tiny module-level registry gets both: `createAiGenerationTask()` writes to
 * it, the plugin reads from it, and neither imports the other. The alternative —
 * asking the app to list its schema names a second time in the package config —
 * would be a list that silently drifts out of sync with the real one, and whose
 * drift shows up as a job that fails on pickup.
 */
const registered = new Map<string, Set<string>>();

export function registerBackgroundSchemas(taskName: string, names: readonly string[]): void {
  const existing = registered.get(taskName) ?? new Set<string>();
  for (const name of names) existing.add(name);
  registered.set(taskName, existing);
}

export function backgroundSchemasFor(taskName: string): ReadonlySet<string> {
  return registered.get(taskName) ?? new Set<string>();
}

/** Tests only — the registry is module-level and would otherwise leak between them. */
export function resetBackgroundSchemas(): void {
  registered.clear();
}
