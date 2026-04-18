/**
 * Derives SearchIndexSettings from an entity's EntitySearchConfig.
 *
 * Converts the declarative per-field config into the provider-facing
 * SearchIndexSettings format used by createOrUpdateIndex.
 */
import type { EntitySearchConfig, SearchFieldConfig } from '@lastshotlabs/slingshot-core';
import type { SearchIndexSettings } from './types/provider';

/**
 * Derive `SearchIndexSettings` from an entity's declarative `EntitySearchConfig`.
 *
 * Converts the per-field configuration object (defined on the entity's
 * `search.fields` map) into the provider-facing `SearchIndexSettings` format
 * consumed by `SearchProvider.createOrUpdateIndex()`.
 *
 * @param searchConfig - The entity's resolved `EntitySearchConfig`, as set in
 *   the entity definition's `search` property.
 * @returns A `SearchIndexSettings` object ready to pass to
 *   `SearchProvider.createOrUpdateIndex()`.
 *
 * @remarks
 * **Field weight ordering** — `searchableFields` is sorted by the field's
 * `weight` property descending before being placed in the output array.
 * Providers that accept an ordered list of searchable fields (Typesense,
 * Meilisearch, Algolia) interpret earlier positions as higher relevance, so
 * a field with `weight: 10` always precedes a field with `weight: 1`.
 * Fields with no `weight` default to `1`.
 *
 * **Searchable default** — a field is searchable unless `searchable: false`
 * is explicitly set. All other flag defaults (`filterable`, `sortable`,
 * `facetable`, `displayed`) are `false`.
 *
 * **Tenant isolation auto-inject** — when the entity is configured with
 * `tenantIsolation: 'filtered'`, the `tenantField` is automatically appended
 * to `filterableFields` (if not already present). This ensures the tenant
 * filter is always executable without requiring authors to manually mark the
 * field as filterable.
 *
 * **Geo auto-inject** — when a `geo` config is present and `autoFilter` is
 * not `false`, the `latField`, `lngField`, and the composite `_geo` field are
 * added to `filterableFields`, and `_geo` is added to `sortableFields`. This
 * enables geo-radius and bounding-box filters and geo-distance sorting without
 * manual field configuration.
 *
 * @example
 * ```ts
 * import { deriveIndexSettings } from '@lastshotlabs/slingshot-search';
 *
 * const settings = deriveIndexSettings({
 *   fields: {
 *     title:   { weight: 10, filterable: false },
 *     status:  { searchable: false, filterable: true, facetable: true },
 *     body:    { weight: 1 },
 *     secret:  { displayed: false },
 *   },
 *   distinctField: 'threadId',
 * });
 *
 * // settings.searchableFields  → ['title', 'body']  (weight desc)
 * // settings.filterableFields  → ['status']
 * // settings.facetableFields   → ['status']
 * // settings.excludedFields    → ['secret']
 * // settings.distinctField     → 'threadId'
 * ```
 */
export function deriveIndexSettings(searchConfig: EntitySearchConfig): SearchIndexSettings {
  const searchable: Array<{ field: string; weight: number }> = [];
  const filterable: string[] = [];
  const sortable: string[] = [];
  const facetable: string[] = [];
  const excluded: string[] = [];

  for (const [fieldName, fieldConfig] of Object.entries(searchConfig.fields)) {
    const fc: SearchFieldConfig = fieldConfig;

    // searchable defaults to true when not explicitly set
    if (fc.searchable !== false) {
      searchable.push({ field: fieldName, weight: fc.weight ?? 1 });
    }

    if (fc.filterable) {
      filterable.push(fieldName);
    }

    if (fc.sortable) {
      sortable.push(fieldName);
    }

    if (fc.facetable) {
      facetable.push(fieldName);
    }

    if (fc.displayed === false) {
      excluded.push(fieldName);
    }
  }

  // Sort searchable fields by weight descending — provider interprets position as priority
  searchable.sort((a, b) => b.weight - a.weight);

  // Auto-add tenantField to filterable set when filtered isolation is configured
  if (searchConfig.tenantIsolation === 'filtered' && searchConfig.tenantField) {
    if (!filterable.includes(searchConfig.tenantField)) {
      filterable.push(searchConfig.tenantField);
    }
  }

  // Add geo fields to filterable and sortable sets when autoFilter is not disabled.
  // Providers expect `_geo` as the composite geo field for geo filtering/sorting.
  if (searchConfig.geo) {
    const { latField, lngField, autoFilter } = searchConfig.geo;
    if (autoFilter !== false) {
      if (!filterable.includes(latField)) filterable.push(latField);
      if (!filterable.includes(lngField)) filterable.push(lngField);
      if (!filterable.includes('_geo')) filterable.push('_geo');
      if (!sortable.includes('_geo')) sortable.push('_geo');
    }
  }

  const settings: SearchIndexSettings = {
    searchableFields: searchable.map(s => s.field),
    filterableFields: filterable,
    sortableFields: sortable,
    facetableFields: facetable,
    ...(excluded.length > 0 ? { excludedFields: excluded } : {}),
    ...(searchConfig.distinctField ? { distinctField: searchConfig.distinctField } : {}),
  };

  return settings;
}
