/**
 * Index settings derivation tests.
 *
 * Tests deriveIndexSettings() against various EntitySearchConfig shapes,
 * verifying field classification, weight-based ordering, geo config, and
 * the distinctField pass-through.
 */
import { describe, expect, it } from 'bun:test';
import type { EntitySearchConfig } from '@lastshotlabs/slingshot-core';
import { deriveIndexSettings } from '../src/indexSettings';

describe('deriveIndexSettings', () => {
  // --- searchable fields ---

  it('fields with searchable: true appear in searchableFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        body: { searchable: true },
        internalCode: { searchable: false },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.searchableFields).toContain('title');
    expect(settings.searchableFields).toContain('body');
    expect(settings.searchableFields).not.toContain('internalCode');
  });

  it('fields with no searchable key default to searchable', () => {
    const config: EntitySearchConfig = {
      fields: {
        name: {},
        secret: { searchable: false },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.searchableFields).toContain('name');
    expect(settings.searchableFields).not.toContain('secret');
  });

  // --- filterable fields ---

  it('fields with filterable: true appear in filterableFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        status: { searchable: false, filterable: true },
        category: { filterable: true },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).toContain('status');
    expect(settings.filterableFields).toContain('category');
    expect(settings.filterableFields).not.toContain('title');
  });

  it('fields without filterable are excluded from filterableFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).toHaveLength(0);
  });

  // --- sortable fields ---

  it('fields with sortable: true appear in sortableFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        createdAt: { searchable: false, sortable: true },
        price: { sortable: true },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.sortableFields).toContain('createdAt');
    expect(settings.sortableFields).toContain('price');
    expect(settings.sortableFields).not.toContain('title');
  });

  // --- weight ordering ---

  it('weight affects ranking order (higher weight = earlier in searchableFields)', () => {
    const config: EntitySearchConfig = {
      fields: {
        body: { weight: 1 },
        title: { weight: 10 },
        tags: { weight: 5 },
      },
    };
    const settings = deriveIndexSettings(config);
    const titleIdx = settings.searchableFields.indexOf('title');
    const tagsIdx = settings.searchableFields.indexOf('tags');
    const bodyIdx = settings.searchableFields.indexOf('body');
    expect(titleIdx).toBeLessThan(tagsIdx);
    expect(tagsIdx).toBeLessThan(bodyIdx);
  });

  // --- geo config ---

  it('geo config with autoFilter adds geo fields to filterableFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        name: { searchable: true },
        lat: { searchable: false },
        lng: { searchable: false },
      },
      geo: {
        latField: 'lat',
        lngField: 'lng',
        autoFilter: true,
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).toContain('lat');
    expect(settings.filterableFields).toContain('lng');
    expect(settings.filterableFields).toContain('_geo');
    expect(settings.sortableFields).toContain('_geo');
  });

  it('geo config without autoFilter (default true) still adds geo fields', () => {
    const config: EntitySearchConfig = {
      fields: {
        name: { searchable: true },
        lat: { searchable: false },
        lng: { searchable: false },
      },
      geo: {
        latField: 'lat',
        lngField: 'lng',
        // autoFilter defaults to true when not specified
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).toContain('_geo');
  });

  it('geo config with autoFilter: false does NOT add geo fields to filterable set', () => {
    const config: EntitySearchConfig = {
      fields: {
        name: { searchable: true },
        lat: { searchable: false },
        lng: { searchable: false },
      },
      geo: {
        latField: 'lat',
        lngField: 'lng',
        autoFilter: false,
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).not.toContain('_geo');
    expect(settings.sortableFields).not.toContain('_geo');
  });

  // --- distinctField ---

  it('distinctField is set correctly in settings', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        groupId: { searchable: false, filterable: true },
      },
      distinctField: 'groupId',
    };
    const settings = deriveIndexSettings(config);
    expect(settings.distinctField).toBe('groupId');
  });

  it('distinctField is undefined when not configured', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.distinctField).toBeUndefined();
  });

  // --- displayed: false → excludedFields ---

  it('fields with displayed: false appear in excludedFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        internalScore: { searchable: false, displayed: false },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(settings.excludedFields).toContain('internalScore');
    expect(settings.excludedFields).not.toContain('title');
  });

  // --- tenant isolation ---

  it('filtered tenant isolation adds tenantField to filterableFields', () => {
    const config: EntitySearchConfig = {
      fields: {
        title: { searchable: true },
        tenantId: { searchable: false },
      },
      tenantIsolation: 'filtered',
      tenantField: 'tenantId',
    };
    const settings = deriveIndexSettings(config);
    expect(settings.filterableFields).toContain('tenantId');
  });

  // --- empty fields config ---

  it('empty fields config produces valid (empty) settings', () => {
    // Note: defineEntity validates at least one searchable field exists,
    // but deriveIndexSettings itself doesn't enforce that constraint.
    const config: EntitySearchConfig = {
      fields: {
        placeholder: { searchable: false, filterable: false, sortable: false },
      },
    };
    const settings = deriveIndexSettings(config);
    expect(Array.isArray(settings.searchableFields)).toBe(true);
    expect(Array.isArray(settings.filterableFields)).toBe(true);
    expect(Array.isArray(settings.sortableFields)).toBe(true);
    expect(Array.isArray(settings.facetableFields)).toBe(true);
  });
});
