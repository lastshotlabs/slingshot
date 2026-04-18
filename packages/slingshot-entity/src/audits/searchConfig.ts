/**
 * Search configuration audit rules.
 *
 * Validates that entity search config references valid fields and is internally consistent.
 */
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type { EntityAuditFinding } from './types';

/**
 * Audit the entity's search configuration for correctness and completeness.
 *
 * Returns immediately with an empty array when `config.search` is not set.
 *
 * Rules emitted:
 * - `search/field-not-found` (error): a key in `search.fields` does not exist
 *   in the entity's field map.
 * - `search/geo-field-not-found` (error): `search.geo.latField` or
 *   `search.geo.lngField` does not exist in the entity.
 * - `search/geo-field-not-numeric` (error): a geo coordinate field is not type
 *   `number` or `integer`.
 * - `search/distinct-field-not-found` (error): `search.distinctField` does not
 *   exist in the entity.
 * - `search/no-searchable-fields` (error): no field has `searchable: true` (or
 *   `searchable` unset, which defaults to `true`).
 * - `search/facet-not-filterable` (warning): a field is `facetable` but not
 *   `filterable` — faceting requires the field to be filterable.
 * - `search/no-filterable-fields` (warning): no fields are marked
 *   `filterable`.
 * - `search/no-sortable-fields` (warning): no fields are marked `sortable`.
 * - `search/no-facetable-fields` (info): no fields are marked `facetable`.
 * - `search/many-weighted-fields` (info): more than 5 fields have non-default
 *   weights, signalling complex relevance tuning.
 * - `search/large-field-displayed` (info): a `json` or `string[]` field is
 *   included in search results by default.
 *
 * @param config - The resolved entity config to audit.
 * @returns An array of `EntityAuditFinding` objects, one per rule violation.
 *   An empty array means no issues were found (or `config.search` is absent).
 */
export function auditSearchConfig(config: ResolvedEntityConfig): EntityAuditFinding[] {
  if (!config.search) return [];
  const findings: EntityAuditFinding[] = [];
  const search = config.search;
  const entityFields = config.fields;

  // -------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------

  // search-field-not-found: Every key in search.fields must exist in entity fields
  for (const fieldName of Object.keys(search.fields)) {
    if (!(fieldName in entityFields)) {
      findings.push({
        severity: 'error',
        rule: 'search/field-not-found',
        entity: config.name,
        message: `Search field '${fieldName}' does not exist in entity fields`,
        suggestion: `Remove '${fieldName}' from search.fields or add it to the entity definition`,
      });
    }
  }

  // search-geo-field-not-found / search-geo-field-not-numeric
  if (search.geo) {
    for (const geoKey of ['latField', 'lngField'] as const) {
      const geoFieldName = search.geo[geoKey];
      if (!(geoFieldName in entityFields)) {
        findings.push({
          severity: 'error',
          rule: 'search/geo-field-not-found',
          entity: config.name,
          message: `Geo ${geoKey} '${geoFieldName}' does not exist in entity fields`,
          suggestion: `Add a number field '${geoFieldName}' to the entity definition`,
        });
      } else {
        const fieldType = entityFields[geoFieldName].type;
        if (fieldType !== 'number' && fieldType !== 'integer') {
          findings.push({
            severity: 'error',
            rule: 'search/geo-field-not-numeric',
            entity: config.name,
            message: `Geo ${geoKey} '${geoFieldName}' is type '${fieldType}' — must be 'number' or 'integer'`,
          });
        }
      }
    }
  }

  // search-distinct-field-not-found
  if (search.distinctField && !(search.distinctField in entityFields)) {
    findings.push({
      severity: 'error',
      rule: 'search/distinct-field-not-found',
      entity: config.name,
      message: `Search distinctField '${search.distinctField}' does not exist in entity fields`,
      suggestion: `Remove distinctField or add '${search.distinctField}' to the entity definition`,
    });
  }

  // search-no-searchable-fields: at least one field must be searchable
  const hasSearchableField = Object.entries(search.fields).some(([fieldName, fieldConfig]) => {
    // Only consider fields that actually exist
    if (!(fieldName in entityFields)) return false;
    // searchable defaults to true when not explicitly set
    return fieldConfig.searchable !== false;
  });
  if (!hasSearchableField) {
    findings.push({
      severity: 'error',
      rule: 'search/no-searchable-fields',
      entity: config.name,
      message: `No searchable fields configured — at least one field must have searchable: true (or omit searchable to default to true)`,
    });
  }

  // -------------------------------------------------------------------
  // Warnings
  // -------------------------------------------------------------------

  // search-facet-not-filterable
  for (const [fieldName, fieldConfig] of Object.entries(search.fields)) {
    if (fieldConfig.facetable && !fieldConfig.filterable) {
      findings.push({
        severity: 'warning',
        rule: 'search/facet-not-filterable',
        entity: config.name,
        message: `Search field '${fieldName}' is facetable but not filterable — faceting requires filtering`,
        suggestion: `Add filterable: true to search.fields['${fieldName}']`,
      });
    }
  }

  // search-no-filterable-fields
  const hasFilterableField = Object.values(search.fields).some(fc => fc.filterable);
  if (!hasFilterableField) {
    findings.push({
      severity: 'warning',
      rule: 'search/no-filterable-fields',
      entity: config.name,
      message: `No filterable search fields — search will only support full-text queries`,
      suggestion: `Mark frequently filtered fields with filterable: true`,
    });
  }

  // search-no-sortable-fields
  const hasSortableField = Object.values(search.fields).some(fc => fc.sortable);
  if (!hasSortableField) {
    findings.push({
      severity: 'warning',
      rule: 'search/no-sortable-fields',
      entity: config.name,
      message: `No sortable search fields — results can only be sorted by relevance`,
      suggestion: `Mark fields used for ordering with sortable: true`,
    });
  }

  // -------------------------------------------------------------------
  // Info
  // -------------------------------------------------------------------

  // search-no-facetable-fields
  const hasFacetableField = Object.values(search.fields).some(fc => fc.facetable);
  if (!hasFacetableField) {
    findings.push({
      severity: 'info',
      rule: 'search/no-facetable-fields',
      entity: config.name,
      message: `No fields configured for faceting`,
    });
  }

  // search-many-weighted-fields
  const weightedCount = Object.values(search.fields).filter(
    fc => fc.weight !== undefined && fc.weight !== 1,
  ).length;
  if (weightedCount > 5) {
    findings.push({
      severity: 'info',
      rule: 'search/many-weighted-fields',
      entity: config.name,
      message: `${weightedCount} fields have custom weights — relevance tuning may be complex`,
    });
  }

  // search-large-field-displayed
  for (const [fieldName, fieldConfig] of Object.entries(search.fields)) {
    if (!(fieldName in entityFields)) continue;
    const fieldType = entityFields[fieldName].type;
    if ((fieldType === 'json' || fieldType === 'string[]') && fieldConfig.displayed !== false) {
      findings.push({
        severity: 'info',
        rule: 'search/large-field-displayed',
        entity: config.name,
        message: `Search field '${fieldName}' is type '${fieldType}' and displayed by default — consider setting displayed: false for large fields not needed in search results`,
      });
    }
  }

  return findings;
}
