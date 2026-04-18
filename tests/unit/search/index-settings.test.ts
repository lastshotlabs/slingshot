import { describe, expect, test } from 'bun:test';
import type { EntitySearchConfig } from '@lastshotlabs/slingshot-core';
import { deriveIndexSettings } from '../../../packages/slingshot-search/src/indexSettings';

// ============================================================================
// Tests
// ============================================================================

describe('deriveIndexSettings', () => {
  // --------------------------------------------------------------------------
  // Searchable fields
  // --------------------------------------------------------------------------

  describe('searchable fields', () => {
    test('fields default to searchable when searchable is not set', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: {},
          body: {},
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.searchableFields).toContain('title');
      expect(settings.searchableFields).toContain('body');
    });

    test('excludes fields with searchable: false', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: { searchable: true },
          secret: { searchable: false },
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.searchableFields).toContain('title');
      expect(settings.searchableFields).not.toContain('secret');
    });
  });

  // --------------------------------------------------------------------------
  // Weight ordering
  // --------------------------------------------------------------------------

  describe('weight ordering', () => {
    test('searchable fields are ordered by weight descending', () => {
      const config: EntitySearchConfig = {
        fields: {
          body: { weight: 1 },
          title: { weight: 10 },
          summary: { weight: 5 },
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.searchableFields).toEqual(['title', 'summary', 'body']);
    });

    test('default weight is 1 when not specified', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: { weight: 5 },
          body: {},
          tags: {},
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.searchableFields[0]).toBe('title');
    });
  });

  // --------------------------------------------------------------------------
  // Filterable fields
  // --------------------------------------------------------------------------

  describe('filterable fields', () => {
    test('extracts fields with filterable: true', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: { searchable: true },
          status: { filterable: true },
          category: { filterable: true },
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.filterableFields).toContain('status');
      expect(settings.filterableFields).toContain('category');
      expect(settings.filterableFields).not.toContain('title');
    });
  });

  // --------------------------------------------------------------------------
  // Sortable fields
  // --------------------------------------------------------------------------

  describe('sortable fields', () => {
    test('extracts fields with sortable: true', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: {},
          createdAt: { sortable: true },
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.sortableFields).toContain('createdAt');
      expect(settings.sortableFields).not.toContain('title');
    });
  });

  // --------------------------------------------------------------------------
  // Facetable fields
  // --------------------------------------------------------------------------

  describe('facetable fields', () => {
    test('extracts fields with facetable: true', () => {
      const config: EntitySearchConfig = {
        fields: {
          category: { facetable: true },
          title: {},
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.facetableFields).toContain('category');
      expect(settings.facetableFields).not.toContain('title');
    });
  });

  // --------------------------------------------------------------------------
  // Excluded fields (displayed: false)
  // --------------------------------------------------------------------------

  describe('excluded fields', () => {
    test('fields with displayed: false go into excludedFields', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: {},
          internalScore: { displayed: false },
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.excludedFields).toContain('internalScore');
    });

    test('excludedFields is omitted when no fields have displayed: false', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: {},
          body: {},
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.excludedFields).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Geo config
  // --------------------------------------------------------------------------

  describe('geo config', () => {
    test('adds geo fields to filterable and sortable when autoFilter is not disabled', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: {},
        },
        geo: {
          latField: 'latitude',
          lngField: 'longitude',
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.filterableFields).toContain('latitude');
      expect(settings.filterableFields).toContain('longitude');
      expect(settings.filterableFields).toContain('_geo');
      expect(settings.sortableFields).toContain('_geo');
    });

    test('does not add geo fields when autoFilter is false', () => {
      const config: EntitySearchConfig = {
        fields: {
          title: {},
        },
        geo: {
          latField: 'latitude',
          lngField: 'longitude',
          autoFilter: false,
        },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.filterableFields).not.toContain('_geo');
      expect(settings.sortableFields).not.toContain('_geo');
    });
  });

  // --------------------------------------------------------------------------
  // distinctField
  // --------------------------------------------------------------------------

  describe('distinctField', () => {
    test('passes through distinctField from entity config', () => {
      const config: EntitySearchConfig = {
        fields: { title: {} },
        distinctField: 'threadId',
      };
      const settings = deriveIndexSettings(config);
      expect(settings.distinctField).toBe('threadId');
    });

    test('distinctField is omitted when not set', () => {
      const config: EntitySearchConfig = {
        fields: { title: {} },
      };
      const settings = deriveIndexSettings(config);
      expect(settings.distinctField).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Combined field attributes
  // --------------------------------------------------------------------------

  test('a field can be searchable, filterable, sortable, and facetable at once', () => {
    const config: EntitySearchConfig = {
      fields: {
        category: {
          searchable: true,
          filterable: true,
          sortable: true,
          facetable: true,
          weight: 3,
        },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.searchableFields).toContain('category');
    expect(settings.filterableFields).toContain('category');
    expect(settings.sortableFields).toContain('category');
    expect(settings.facetableFields).toContain('category');
  });
});
