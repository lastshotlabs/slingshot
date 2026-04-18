/**
 * Index coverage audit rules.
 *
 * Checks that operations and entity config have appropriate indexes.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { EntityAuditFinding } from './types';

function getIndexedFields(config: ResolvedEntityConfig): Set<string> {
  const indexed = new Set<string>();
  indexed.add(config._pkField);
  if (config.indexes) {
    for (const idx of config.indexes) {
      for (const f of idx.fields) indexed.add(f);
    }
  }
  if (config.uniques) {
    for (const uq of config.uniques) {
      for (const f of uq.fields) indexed.add(f);
    }
  }
  return indexed;
}

/**
 * Audit an entity config for missing index coverage.
 *
 * Checks that fields used in common query patterns — cursor pagination, soft
 * delete filtering, lookup conditions, aggregate `groupBy`, and upsert match
 * constraints — are covered by a declared `index` or `unique` entry on the
 * entity.
 *
 * Rules emitted:
 * - `index-coverage/cursor-pagination` (warning): a cursor pagination field is
 *   not indexed.
 * - `index-coverage/soft-delete` (warning): the soft-delete field is not
 *   indexed even though every list query filters on it.
 * - `index-coverage/lookup` (warning): a `lookup` operation field is not
 *   indexed — will cause a full-table scan.
 * - `index-coverage/search` (info): reminds the developer to add backend-specific
 *   text indexes (FTS5, `$text`, GIN/tsvector) for `search` operations.
 * - `index-coverage/aggregate-groupby` (warning): a `groupBy` field is not
 *   indexed.
 * - `index-coverage/upsert-unique` (warning): the upsert `match` fields do not
 *   have a matching unique constraint — upsert behavior will be incorrect.
 *
 * @param config - The resolved entity config to audit.
 * @param operations - Optional map of operation name → operation config. When
 *   omitted, only structural index checks (cursor pagination, soft delete) are
 *   performed.
 * @returns An array of `EntityAuditFinding` objects, one per rule violation.
 *   An empty array means no issues were found.
 */
export function auditIndexCoverage(
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAuditFinding[] {
  const findings: EntityAuditFinding[] = [];
  const indexed = getIndexedFields(config);

  // Cursor pagination fields should be indexed
  if (config.pagination?.cursor.fields) {
    for (const f of config.pagination.cursor.fields) {
      if (!indexed.has(f)) {
        findings.push({
          severity: 'warning',
          rule: 'index-coverage/cursor-pagination',
          entity: config.name,
          message: `Cursor pagination field '${f}' is not indexed — list queries will be slow`,
          suggestion: `Add an index on '${f}' or include it in a compound index`,
        });
      }
    }
  }

  // Soft-delete field should be indexed
  if (config.softDelete && !indexed.has(config.softDelete.field)) {
    findings.push({
      severity: 'warning',
      rule: 'index-coverage/soft-delete',
      entity: config.name,
      message: `Soft-delete field '${config.softDelete.field}' is not indexed — all list queries filter on it`,
      suggestion: `Add an index containing '${config.softDelete.field}'`,
    });
  }

  if (!operations) return findings;

  // Operation-specific index checks
  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'lookup': {
        for (const field of Object.keys(op.fields)) {
          if (field.startsWith('param:')) continue;
          if (!indexed.has(field)) {
            findings.push({
              severity: 'warning',
              rule: 'index-coverage/lookup',
              entity: config.name,
              operation: opName,
              message: `Lookup field '${field}' is not indexed — queries will scan all records`,
              suggestion: `Add an index on '${field}'`,
            });
          }
        }
        break;
      }

      case 'search': {
        findings.push({
          severity: 'info',
          rule: 'index-coverage/search',
          entity: config.name,
          operation: opName,
          message: `Search operation on [${op.fields.join(', ')}] — ensure text indexes exist for SQLite (FTS5), Mongo ($text), and Postgres (GIN/tsvector)`,
        });
        break;
      }

      case 'aggregate': {
        const groupByField =
          typeof op.groupBy === 'string' ? op.groupBy : op.groupBy ? op.groupBy.field : undefined;
        if (groupByField && !indexed.has(groupByField)) {
          findings.push({
            severity: 'warning',
            rule: 'index-coverage/aggregate-groupby',
            entity: config.name,
            operation: opName,
            message: `Aggregate groupBy field '${groupByField}' is not indexed`,
            suggestion: `Add an index on '${groupByField}' for better aggregation performance`,
          });
        }
        break;
      }

      case 'upsert': {
        const matchFields = [...op.match];
        const hasMatchingUnique = config.uniques?.some(
          uq =>
            matchFields.length === uq.fields.length &&
            matchFields.every(f => uq.fields.includes(f)),
        );
        if (!hasMatchingUnique) {
          findings.push({
            severity: 'warning',
            rule: 'index-coverage/upsert-unique',
            entity: config.name,
            operation: opName,
            message: `Upsert match fields [${matchFields.join(', ')}] don't have a matching unique constraint`,
            suggestion: `Add a unique constraint on [${matchFields.join(', ')}] for correct upsert behavior`,
          });
        }
        break;
      }
    }
  }

  return findings;
}
