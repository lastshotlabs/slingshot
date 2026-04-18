/**
 * Structural audit rules.
 *
 * Validates entity field definitions for correctness.
 */
import type { FieldDef, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { EntityAuditFinding } from './types';

/**
 * Audit an entity config for structural field-definition errors.
 *
 * Validates that field-level settings (defaults, auto-update, soft-delete) are
 * type-compatible and that the entity has a reasonable index strategy.
 *
 * Rules emitted:
 * - `structural/onUpdate-type` (error): a field declares `onUpdate: 'now'` but
 *   is not type `date` — only date fields support auto-refresh on update.
 * - `structural/auto-default-type` (error): a field has `default: 'uuid'` or
 *   `default: 'cuid'` but is not type `string`.
 * - `structural/now-default-type` (error): a field has `default: 'now'` but is
 *   not type `date`.
 * - `structural/soft-delete-type` (warning): the soft-delete field is not type
 *   `enum`, `boolean`, or `string` — other types are unusual.
 * - `structural/no-indexes` (info): the entity has more than 5 fields but
 *   declares no indexes or unique constraints.
 *
 * @param config - The resolved entity config to audit.
 * @returns An array of `EntityAuditFinding` objects, one per rule violation.
 *   An empty array means no issues were found.
 */
export function auditStructural(config: ResolvedEntityConfig): EntityAuditFinding[] {
  const findings: EntityAuditFinding[] = [];

  for (const [name, def] of Object.entries(config.fields)) {
    // onUpdate: 'now' only makes sense on date fields
    if (def.onUpdate === 'now' && def.type !== 'date') {
      findings.push({
        severity: 'error',
        rule: 'structural/onUpdate-type',
        entity: config.name,
        message: `Field '${name}' has onUpdate: 'now' but is type '${def.type}' — only 'date' fields support this`,
      });
    }

    // default: 'uuid' / 'cuid' only on string fields
    if ((def.default === 'uuid' || def.default === 'cuid') && def.type !== 'string') {
      findings.push({
        severity: 'error',
        rule: 'structural/auto-default-type',
        entity: config.name,
        message: `Field '${name}' has default: '${def.default}' but is type '${def.type}' — only 'string' fields support UUID/CUID defaults`,
      });
    }

    // default: 'now' only on date fields
    if (def.default === 'now' && def.type !== 'date') {
      findings.push({
        severity: 'error',
        rule: 'structural/now-default-type',
        entity: config.name,
        message: `Field '${name}' has default: 'now' but is type '${def.type}' — only 'date' fields support 'now' defaults`,
      });
    }
  }

  // Soft-delete field should be enum or boolean
  if (config.softDelete) {
    const sdField = (config.fields as Record<string, FieldDef | undefined>)[
      config.softDelete.field
    ];
    if (
      sdField &&
      sdField.type !== 'enum' &&
      sdField.type !== 'boolean' &&
      sdField.type !== 'string'
    ) {
      findings.push({
        severity: 'warning',
        rule: 'structural/soft-delete-type',
        entity: config.name,
        message: `Soft-delete field '${config.softDelete.field}' is type '${sdField.type}' — consider using 'enum' or 'boolean' for clarity`,
      });
    }
  }

  // No indexes at all — suggest adding some
  const fieldCount = Object.keys(config.fields).length;
  if (
    fieldCount > 5 &&
    (!config.indexes || config.indexes.length === 0) &&
    (!config.uniques || config.uniques.length === 0)
  ) {
    findings.push({
      severity: 'info',
      rule: 'structural/no-indexes',
      entity: config.name,
      message: `Entity has ${fieldCount} fields but no indexes or unique constraints`,
      suggestion: `Add indexes on fields used in lookups, filters, and sorting`,
    });
  }

  return findings;
}
