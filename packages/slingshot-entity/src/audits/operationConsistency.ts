/**
 * Operation consistency audit rules.
 *
 * Validates that operation configs are consistent with entity definitions.
 */
import type { FieldDef, OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { EntityAuditFinding } from './types';

/**
 * Audit operation configs for consistency with the entity field definition.
 *
 * Validates that each operation references fields and values that actually
 * exist on the entity and are semantically compatible with their declared types.
 *
 * Rules emitted per operation kind:
 * - `transition`:
 *   - `consistency/transition-field` (error): `op.field` does not exist on the entity.
 *   - `consistency/transition-from-value` (error): `op.from` is not in the field's
 *     `enumValues` list.
 *   - `consistency/transition-to-value` (error): `op.to` is not in the field's
 *     `enumValues` list.
 * - `fieldUpdate`:
 *   - `consistency/fieldUpdate-field` (error): a field in `op.set` does not exist.
 *   - `consistency/fieldUpdate-immutable` (error): a field in `op.set` is declared
 *     `immutable`.
 * - `collection`:
 *   - `consistency/collection-parentKey` (error): `op.parentKey` does not exist.
 *   - `consistency/collection-identifyBy` (error): `update` or `remove` sub-operations
 *     are declared but `op.identifyBy` is missing.
 * - `consume`:
 *   - `consistency/consume-expiry-field` (error): `op.expiry.field` does not exist.
 *   - `consistency/consume-expiry-type` (error): `op.expiry.field` is not type `date`.
 * - `computedAggregate`:
 *   - `consistency/computedAggregate-materializeTo` (warning): `op.materializeTo` is
 *     not a declared field — the value will still be written but won't have a schema.
 *   - `consistency/computedAggregate-atomic` (info): `op.atomic: true` has caveats for
 *     memory and Redis backends.
 * - `batch`:
 *   - `consistency/batch-filter-index` (warning): a filter field is not indexed.
 *
 * @param config - The resolved entity config to audit against.
 * @param operations - Optional map of operation name → operation config. When
 *   omitted the function returns an empty array immediately.
 * @returns An array of `EntityAuditFinding` objects, one per rule violation.
 *   An empty array means no issues were found.
 */
export function auditOperationConsistency(
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAuditFinding[] {
  if (!operations) return [];
  const findings: EntityAuditFinding[] = [];

  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'transition': {
        const field = (config.fields as Record<string, FieldDef | undefined>)[op.field];
        if (!field) {
          findings.push({
            severity: 'error',
            rule: 'consistency/transition-field',
            entity: config.name,
            operation: opName,
            message: `Transition references nonexistent field '${op.field}'`,
          });
          break;
        }
        // If enum, check from/to values are valid
        if (field.type === 'enum' && field.enumValues) {
          const enumVals = field.enumValues;
          const fromValues = Array.isArray(op.from) ? op.from.map(String) : [String(op.from)];
          if (fromValues.some(value => !enumVals.includes(value))) {
            findings.push({
              severity: 'error',
              rule: 'consistency/transition-from-value',
              entity: config.name,
              operation: opName,
              message: `Transition 'from' value '${fromValues.join(', ')}' is not in enum [${enumVals.join(', ')}]`,
            });
          }
          if (!enumVals.includes(String(op.to))) {
            findings.push({
              severity: 'error',
              rule: 'consistency/transition-to-value',
              entity: config.name,
              operation: opName,
              message: `Transition 'to' value '${op.to}' is not in enum [${enumVals.join(', ')}]`,
            });
          }
        }
        break;
      }

      case 'fieldUpdate': {
        for (const f of op.set) {
          if (!(f in config.fields)) {
            findings.push({
              severity: 'error',
              rule: 'consistency/fieldUpdate-field',
              entity: config.name,
              operation: opName,
              message: `fieldUpdate references nonexistent field '${f}'`,
            });
          } else if (config.fields[f].immutable) {
            findings.push({
              severity: 'error',
              rule: 'consistency/fieldUpdate-immutable',
              entity: config.name,
              operation: opName,
              message: `fieldUpdate tries to update immutable field '${f}'`,
            });
          }
        }
        break;
      }

      case 'collection': {
        if (!(op.parentKey in config.fields)) {
          findings.push({
            severity: 'error',
            rule: 'consistency/collection-parentKey',
            entity: config.name,
            operation: opName,
            message: `Collection parentKey '${op.parentKey}' does not exist on entity`,
          });
        }
        if (
          (op.operations.includes('update') || op.operations.includes('remove')) &&
          !op.identifyBy
        ) {
          findings.push({
            severity: 'error',
            rule: 'consistency/collection-identifyBy',
            entity: config.name,
            operation: opName,
            message: `Collection with 'update' or 'remove' requires 'identifyBy'`,
          });
        }
        break;
      }

      case 'consume': {
        if (op.expiry) {
          const field = (config.fields as Record<string, FieldDef | undefined>)[op.expiry.field];
          if (!field) {
            findings.push({
              severity: 'error',
              rule: 'consistency/consume-expiry-field',
              entity: config.name,
              operation: opName,
              message: `Consume expiry references nonexistent field '${op.expiry.field}'`,
            });
          } else if (field.type !== 'date') {
            findings.push({
              severity: 'error',
              rule: 'consistency/consume-expiry-type',
              entity: config.name,
              operation: opName,
              message: `Consume expiry field '${op.expiry.field}' should be a date type, got '${field.type}'`,
            });
          }
        }
        break;
      }

      case 'computedAggregate': {
        if (!(op.materializeTo in config.fields)) {
          findings.push({
            severity: 'warning',
            rule: 'consistency/computedAggregate-materializeTo',
            entity: config.name,
            operation: opName,
            message: `computedAggregate materializeTo '${op.materializeTo}' does not exist as a field — will be added as a dynamic field`,
            suggestion: `Add a json field '${op.materializeTo}' to the entity definition`,
          });
        }
        if (op.atomic) {
          findings.push({
            severity: 'info',
            rule: 'consistency/computedAggregate-atomic',
            entity: config.name,
            operation: opName,
            message: `computedAggregate with atomic: true — memory backend is single-threaded (always atomic), Redis has no real transactions`,
            suggestion: `Use SQLite/Postgres/Mongo for true transactional atomicity`,
          });
        }
        break;
      }

      case 'batch': {
        const indexedFields = new Set<string>();
        indexedFields.add(config._pkField);
        if (config.indexes) {
          for (const idx of config.indexes) {
            for (const f of idx.fields) indexedFields.add(f);
          }
        }
        if (config.uniques) {
          for (const uq of config.uniques) {
            for (const f of uq.fields) indexedFields.add(f);
          }
        }

        // Recurse into $and/$or to find all referenced fields
        function checkFilterFields(filter: Record<string, unknown>): void {
          for (const [key, value] of Object.entries(filter)) {
            if (key === '$and' || key === '$or') {
              if (Array.isArray(value)) {
                for (const sub of value) {
                  if (typeof sub === 'object' && sub !== null) {
                    checkFilterFields(sub as Record<string, unknown>);
                  }
                }
              }
              continue;
            }
            if (!indexedFields.has(key)) {
              findings.push({
                severity: 'warning',
                rule: 'consistency/batch-filter-index',
                entity: config.name,
                operation: opName,
                message: `Batch filter field '${key}' is not indexed — will scan all records`,
                suggestion: `Add an index on '${key}' for better batch performance`,
              });
            }
          }
        }

        checkFilterFields(op.filter as Record<string, unknown>);
        break;
      }
    }
  }

  return findings;
}
