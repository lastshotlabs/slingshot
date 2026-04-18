/**
 * Entity config differ — pure function that compares two entity definitions
 * and produces a MigrationPlan describing what changed.
 */
import { storageName } from '../lib/naming';
import type { FieldDef, IndexDef, ResolvedEntityConfig } from '../types';
import type { MigrationChange, MigrationPlan } from './types';

function indexKey(idx: IndexDef): string {
  return `${idx.fields.join(',')}:${idx.direction ?? 'asc'}:${idx.unique ?? false}`;
}

function uniqueKey(uq: { fields: readonly string[] }): string {
  return [...uq.fields].sort().join(',');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every(k =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Diff two `ResolvedEntityConfig` snapshots and produce a `MigrationPlan`.
 *
 * Compares fields, indexes, unique constraints, soft-delete config, and
 * pagination config between the previous and current entity definition. The
 * result is consumed by `generateMigrationSqlite()`, `generateMigrationPostgres()`,
 * and `generateMigrationMongo()` to produce DDL migration scripts.
 *
 * @param previous - The earlier entity config (typically loaded from a snapshot).
 * @param current - The new entity config (the current source-of-truth definition).
 * @returns A `MigrationPlan` describing what changed.
 *
 * @throws {Error} When the primary key field changed between snapshots, since
 *   PK changes cannot be automated safely.
 *
 * @remarks
 * **Change ordering guarantee:** within a single diff, removals are emitted
 * before additions for indexes and unique constraints. This matters when the
 * same physical index changes shape (e.g. a non-unique index becomes unique):
 * the old index must be dropped first, otherwise `CREATE INDEX IF NOT EXISTS`
 * would silently no-op on the existing name.
 *
 * @example
 * ```ts
 * import { diffEntityConfig } from '@lastshotlabs/slingshot-entity';
 *
 * const plan = diffEntityConfig(previousConfig, currentConfig);
 * console.log(`${plan.changes.length} changes, breaking: ${plan.hasBreakingChanges}`);
 * ```
 */
export function diffEntityConfig(
  previous: ResolvedEntityConfig,
  current: ResolvedEntityConfig,
): MigrationPlan {
  const changes: MigrationChange[] = [];
  const warnings: string[] = [];
  let hasBreakingChanges = false;

  // PK change — not supported
  if (previous._pkField !== current._pkField) {
    throw new Error(
      `[migration:${current.name}] Primary key changed from '${previous._pkField}' to '${current._pkField}'. ` +
        `PK changes require manual migration.`,
    );
  }

  // Field diffs
  const prevFields = previous.fields;
  const currFields = current.fields;

  // Removed fields first (drops before adds is the consistent convention)
  for (const [name, def] of Object.entries(prevFields)) {
    if (!(name in currFields)) {
      changes.push({ type: 'removeField', name, field: def });
      if (!def.optional) {
        warnings.push(
          `Removing non-optional field '${name}' — existing records may have data in this column`,
        );
      }
    }
  }

  // Added fields
  for (const [name, def] of Object.entries(currFields)) {
    if (!(name in prevFields)) {
      changes.push({ type: 'addField', name, field: def });
    }
  }

  // Changed field types
  for (const [name, currDef] of Object.entries(currFields)) {
    const prevDef = (prevFields as Record<string, FieldDef | undefined>)[name];
    if (prevDef && prevDef.type !== currDef.type) {
      changes.push({ type: 'changeFieldType', name, from: prevDef.type, to: currDef.type });
      hasBreakingChanges = true;
      warnings.push(
        `Field '${name}' type changed from '${prevDef.type}' to '${currDef.type}' — requires manual data migration`,
      );
    }
  }

  // Index diffs — drops first, then creates. Indexes keyed by shape (fields +
  // direction + unique) so a toggle produces remove+add with the same
  // physical name in the correct order.
  const prevIndexes = new Map((previous.indexes ?? []).map(idx => [indexKey(idx), idx]));
  const currIndexes = new Map((current.indexes ?? []).map(idx => [indexKey(idx), idx]));

  for (const [key, idx] of prevIndexes) {
    if (!currIndexes.has(key)) {
      changes.push({ type: 'removeIndex', index: idx });
    }
  }
  for (const [key, idx] of currIndexes) {
    if (!prevIndexes.has(key)) {
      // If the same physical index (same fields) also appears in the removal
      // list above, the drop is guaranteed to precede this create — the
      // iteration order matches insertion order.
      changes.push({ type: 'addIndex', index: idx });
    }
  }

  // Unique constraint diffs — same drops-before-creates discipline
  const prevUniques = new Map((previous.uniques ?? []).map(uq => [uniqueKey(uq), uq]));
  const currUniques = new Map((current.uniques ?? []).map(uq => [uniqueKey(uq), uq]));

  for (const [key, uq] of prevUniques) {
    if (!currUniques.has(key)) {
      changes.push({ type: 'removeUnique', unique: uq });
    }
  }
  for (const [key, uq] of currUniques) {
    if (!prevUniques.has(key)) {
      changes.push({ type: 'addUnique', unique: uq });
    }
  }

  // Soft-delete config change
  const prevSD = previous.softDelete;
  const currSD = current.softDelete;
  if (!deepEqual(prevSD, currSD)) {
    changes.push({ type: 'changeSoftDelete', from: prevSD, to: currSD });
    if (prevSD && !currSD)
      warnings.push(
        'Soft-delete removed — previously soft-deleted records are now permanently invisible',
      );
    if (!prevSD && currSD)
      warnings.push('Soft-delete added — existing records will all be considered "active"');
  }

  // Pagination config change
  const prevPag = previous.pagination;
  const currPag = current.pagination;
  if (!deepEqual(prevPag, currPag)) {
    changes.push({ type: 'changePagination', from: prevPag, to: currPag });
  }

  return {
    entity: current.name,
    namespace: current.namespace,
    storageName: current._storageName,
    storageNames: {
      sqlite: storageName(current, 'sqlite'),
      postgres: storageName(current, 'postgres'),
      mongo: storageName(current, 'mongo'),
    },
    changes,
    hasBreakingChanges,
    warnings,
  };
}
