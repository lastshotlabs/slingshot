/**
 * generateRetentionJob — codegen for retention job factories.
 *
 * When `routes.retention.hardDelete` is configured, the generated routes.ts
 * includes a `create{Name}RetentionJob()` factory that the consumer wires to
 * their scheduler. Framework does NOT auto-schedule.
 *
 * The generated function:
 *   1. Computes a cutoff date from the configured duration (e.g. '90d')
 *   2. Lists records matching the `when` filter AND where the date field < cutoff
 *   3. Deletes each matched record
 *   4. Returns the count of deleted records
 */
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';

/**
 * Return `true` when the entity has a `hardDelete` retention policy configured.
 *
 * A retention job factory is only emitted when `config.routes.retention.hardDelete`
 * is defined. Use this guard before calling `generateRetentionJob()`.
 *
 * @param config - The resolved entity configuration to inspect.
 * @returns `true` if `config.routes.retention.hardDelete` is set; `false` otherwise.
 *
 * @example
 * ```ts
 * import { hasRetention, generateRetentionJob } from '@lastshotlabs/slingshot-entity';
 *
 * if (hasRetention(config)) {
 *   const jobSource = generateRetentionJob(config);
 * }
 * ```
 */
export function hasRetention(config: ResolvedEntityConfig): boolean {
  return !!config.routes?.retention?.hardDelete;
}

/**
 * Generate the retention job factory source code for inclusion in `routes.ts`.
 *
 * Returns a `create{Name}RetentionJob(adapter)` factory function that, when
 * called, returns an `async () => number` job. The job:
 * 1. Computes a cutoff date from the configured `after` duration string
 *    (e.g. `'90d'`).
 * 2. Calls `adapter.list()` with the configured `when` filter merged with a
 *    `updatedAt < cutoff` constraint (limit 1000).
 * 3. Hard-deletes each matched record via `adapter.delete()`.
 * 4. Returns the count of deleted records.
 *
 * Also emits an inline `parseDuration(s)` helper that converts duration strings
 * (`'30s'`, `'5m'`, `'2h'`, `'7d'`, `'1w'`, `'1y'`) to milliseconds.
 *
 * @param config - The resolved entity configuration. Must have
 *   `config.routes.retention.hardDelete` set, otherwise returns `''`.
 * @returns A string containing the TypeScript source code for the retention job
 *   factory, or `''` when no retention config is present.
 *
 * @remarks
 * The framework does NOT auto-schedule retention jobs. Consumers must call the
 * factory and wire the returned function to their own scheduler (e.g. a cron job
 * or background worker).
 *
 * @example
 * ```ts
 * import { generateRetentionJob } from '@lastshotlabs/slingshot-entity';
 *
 * const jobSource = generateRetentionJob(config);
 * // Append jobSource to the entity's routes.ts output
 * ```
 */
export function generateRetentionJob(config: ResolvedEntityConfig): string {
  const retention = config.routes?.retention?.hardDelete;
  if (!retention) return '';

  const name = config.name;
  const pkField = config._pkField;
  const { after, when } = retention;

  // Serialize the `when` filter as a JSON literal in the generated source
  const whenJson = JSON.stringify(when);

  const lines: string[] = [];

  lines.push(
    `export function create${name}RetentionJob(adapter: ${name}Adapter): () => Promise<number> {`,
  );
  lines.push(`  return async () => {`);
  lines.push(`    const cutoffMs = Date.now() - parseDuration(${JSON.stringify(after)});`);
  lines.push(`    const cutoff = new Date(cutoffMs);`);
  lines.push(`    const filter = { ...${whenJson}, updatedAt: { $lt: cutoff } };`);
  lines.push(`    const { items } = await adapter.list({ filter, limit: 1000 });`);
  lines.push(
    `    for (const item of items) await adapter.delete((item as Record<string, unknown>)[${JSON.stringify(pkField)}] as string);`,
  );
  lines.push(`    return items.length;`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function parseDuration(s: string): number {`);
  lines.push(`  const m = s.match(/^(\\d+)([smhdwy])$/);`);
  lines.push(`  if (!m) throw new Error('Invalid duration: ' + s);`);
  lines.push(`  const n = parseInt(m[1], 10);`);
  lines.push(`  const units: Record<string, number> = {`);
  lines.push(`    s: 1000,`);
  lines.push(`    m: 60_000,`);
  lines.push(`    h: 3_600_000,`);
  lines.push(`    d: 86_400_000,`);
  lines.push(`    w: 604_800_000,`);
  lines.push(`    y: 31_536_000_000,`);
  lines.push(`  };`);
  lines.push(`  return n * units[m[2]];`);
  lines.push(`}`);

  return lines.join('\n');
}
