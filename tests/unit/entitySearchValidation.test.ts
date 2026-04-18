import { describe, expect, it } from 'bun:test';
import { field } from '../../packages/slingshot-core/src/entityConfig';
import { validateEntityConfig } from '../../packages/slingshot-entity/src/validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid entity config shape for use with validateEntityConfig. */
function makeEntityConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Product',
    fields: {
      id: { type: 'string', optional: false, primary: true, immutable: true, default: 'uuid' },
      title: { type: 'string', optional: false, primary: false, immutable: false },
      body: { type: 'string', optional: false, primary: false, immutable: false },
      category: { type: 'string', optional: false, primary: false, immutable: false },
      price: { type: 'number', optional: false, primary: false, immutable: false },
      lat: { type: 'number', optional: false, primary: false, immutable: false },
      lng: { type: 'number', optional: false, primary: false, immutable: false },
      tenantId: { type: 'string', optional: false, primary: false, immutable: false },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('entityConfigSchema — search field validation', () => {
  // -----------------------------------------------------------------------
  // No search config — still valid
  // -----------------------------------------------------------------------

  it('entity without search config passes validation', () => {
    const result = validateEntityConfig(makeEntityConfig());
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Valid search configs
  // -----------------------------------------------------------------------

  it('entity with valid search config passes validation', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          provider: 'default',
          fields: {
            title: { searchable: true, weight: 2, filterable: true, sortable: true },
            body: { searchable: true },
            category: { filterable: true, facetable: true },
            price: { filterable: true, sortable: true },
          },
          syncMode: 'write-through',
          indexName: 'products',
          distinctField: 'id',
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('entity with geo search config and number fields passes validation', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          geo: { latField: 'lat', lngField: 'lng', autoFilter: true },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('entity with tenantIsolation and valid tenantField passes validation', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          tenantIsolation: 'filtered',
          tenantField: 'tenantId',
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // search.fields cross-field validation
  // -----------------------------------------------------------------------

  it('search field referencing nonexistent entity field fails with correct message', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
            ghostField: { searchable: true },
          },
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(i => i.message.includes('ghostField') && i.message.includes('unknown field')),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('ghostField'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // search.geo cross-field validation
  // -----------------------------------------------------------------------

  it('search geo latField referencing nonexistent field fails with correct message', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          geo: { latField: 'nonexistentLat', lngField: 'lng' },
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(i => i.message.includes('nonexistentLat') && i.message.includes('not found')),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('latField'))).toBe(true);
  });

  it('search geo lngField referencing nonexistent field fails with correct message', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          geo: { latField: 'lat', lngField: 'nonexistentLng' },
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(i => i.message.includes('nonexistentLng') && i.message.includes('not found')),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('lngField'))).toBe(true);
  });

  it('search geo latField referencing non-number field fails with correct message', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          geo: { latField: 'title', lngField: 'lng' },
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(i => i.message.includes('title') && i.message.includes("must be type 'number'")),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('latField'))).toBe(true);
  });

  it('search geo lngField referencing non-number field fails with correct message', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          geo: { latField: 'lat', lngField: 'category' },
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(
        i => i.message.includes('category') && i.message.includes("must be type 'number'"),
      ),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('lngField'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // search.distinctField validation
  // -----------------------------------------------------------------------

  it('search distinctField referencing nonexistent field fails with correct message', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          distinctField: 'nonexistentDistinct',
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(
        i => i.message.includes('nonexistentDistinct') && i.message.includes('not found'),
      ),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('distinctField'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // search.syncMode validation
  // -----------------------------------------------------------------------

  it('invalid syncMode value fails validation', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          syncMode: 'real-time', // invalid — not in enum
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(issues.some(i => i.path.includes('syncMode'))).toBe(true);
  });

  it('valid syncMode values pass validation', () => {
    for (const syncMode of ['write-through', 'event-bus', 'manual'] as const) {
      const result = validateEntityConfig(
        makeEntityConfig({
          search: {
            fields: {
              title: { searchable: true },
            },
            syncMode,
          },
        }),
      );
      expect(result.success).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // search.tenantIsolation + tenantField validation
  // -----------------------------------------------------------------------

  it('invalid tenantIsolation value fails validation', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          tenantIsolation: 'shared', // invalid — not in enum
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(issues.some(i => i.path.includes('tenantIsolation'))).toBe(true);
  });

  it('tenantField referencing nonexistent field fails when tenantIsolation is set', () => {
    const result = validateEntityConfig(
      makeEntityConfig({
        search: {
          fields: {
            title: { searchable: true },
          },
          tenantIsolation: 'filtered',
          tenantField: 'nonexistentTenant',
        },
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.errors?.issues ?? [];
    expect(
      issues.some(i => i.message.includes('nonexistentTenant') && i.message.includes('not found')),
    ).toBe(true);
    expect(issues.some(i => i.path.includes('tenantField'))).toBe(true);
  });
});
