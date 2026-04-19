import { describe, expect, it } from 'bun:test';
import { defineEntity, field } from '../../packages/slingshot-core/src/entityConfig';
import type {
  EntitySearchConfig,
  FieldDef,
  ResolvedEntityConfig,
} from '../../packages/slingshot-core/src/entityConfig';
import { auditEntity } from '../../packages/slingshot-entity/src/audits';
import { auditSearchConfig } from '../../packages/slingshot-entity/src/audits/searchConfig';
import type { EntityAuditFinding } from '../../packages/slingshot-entity/src/audits/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByRule(findings: readonly EntityAuditFinding[], rule: string) {
  return findings.filter(f => f.rule === rule);
}

/**
 * Build a ResolvedEntityConfig directly (bypassing defineEntity validation)
 * so we can test audit rules against invalid configs that defineEntity would reject.
 */
function makeConfig(
  name: string,
  fields: Record<string, FieldDef>,
  search?: EntitySearchConfig,
): ResolvedEntityConfig {
  // Find primary key (or default to 'id')
  let pkField = 'id';
  for (const [fn, def] of Object.entries(fields)) {
    if (def.primary) {
      pkField = fn;
      break;
    }
  }
  const entity = {
    name,
    fields,
    _pkField: pkField,
    _storageName: name.toLowerCase() + 's',
    search,
  };
  return entity as ResolvedEntityConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Search Audit Rules', () => {
  // -----------------------------------------------------------------------
  // Valid config — no errors
  // -----------------------------------------------------------------------

  it('produces no errors for a valid search config', () => {
    const Product = defineEntity('Product', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        title: field.string(),
        body: field.string(),
        category: field.string(),
        price: field.number(),
      },
      search: {
        fields: {
          title: { searchable: true, filterable: true, sortable: true },
          body: { searchable: true },
          category: { filterable: true, facetable: true },
          price: { filterable: true, sortable: true },
        },
      },
    });
    const result = auditEntity(Product);
    expect(result.errors).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Errors
  // -----------------------------------------------------------------------

  describe('errors', () => {
    it('search/field-not-found — field referenced in search.fields does not exist', () => {
      const config = makeConfig(
        'E1',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: {
            title: { searchable: true },
            nonexistent: { searchable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/field-not-found');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('error');
      expect(matches[0].message).toContain('nonexistent');
    });

    it('search/geo-field-not-found — geo latField/lngField not in entity fields', () => {
      const config = makeConfig(
        'E2',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: { title: {} },
          geo: { latField: 'latitude', lngField: 'longitude' },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/geo-field-not-found');
      expect(matches.length).toBe(2);
      expect(matches.every(m => m.severity === 'error')).toBe(true);
    });

    it('search/geo-field-not-numeric — geo fields must be number type', () => {
      const config = makeConfig(
        'E3',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          lat: field.string(),
          lng: field.boolean(),
        },
        {
          fields: { title: {} },
          geo: { latField: 'lat', lngField: 'lng' },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/geo-field-not-numeric');
      expect(matches.length).toBe(2);
      expect(matches.every(m => m.severity === 'error')).toBe(true);
    });

    it('search/geo-field-not-numeric — integer geo fields are acceptable', () => {
      const config = makeConfig(
        'E3b',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          lat: field.integer(),
          lng: field.number(),
        },
        {
          fields: { title: {} },
          geo: { latField: 'lat', lngField: 'lng' },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/geo-field-not-numeric');
      expect(matches.length).toBe(0);
    });

    it('search/distinct-field-not-found — distinctField not in entity fields', () => {
      const config = makeConfig(
        'E4',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: { title: {} },
          distinctField: 'groupId',
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/distinct-field-not-found');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('error');
    });

    it('search/distinct-field-not-found — valid distinctField produces no error', () => {
      const config = makeConfig(
        'E4b',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          groupId: field.string(),
        },
        {
          fields: { title: {} },
          distinctField: 'groupId',
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/distinct-field-not-found');
      expect(matches.length).toBe(0);
    });

    it('search/no-searchable-fields — all fields have searchable: false', () => {
      const config = makeConfig(
        'E5',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          category: field.string(),
        },
        {
          fields: {
            title: { searchable: false, filterable: true, sortable: true },
            category: { searchable: false, filterable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/no-searchable-fields');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('error');
    });

    it('search/no-searchable-fields — omitting searchable defaults to true (no error)', () => {
      const config = makeConfig(
        'E5b',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: {
            title: { filterable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/no-searchable-fields');
      expect(matches.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Warnings
  // -----------------------------------------------------------------------

  describe('warnings', () => {
    it('search/facet-not-filterable — facetable without filterable', () => {
      const config = makeConfig(
        'W1',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          category: field.string(),
        },
        {
          fields: {
            title: { sortable: true },
            category: { facetable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/facet-not-filterable');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('warning');
      expect(matches[0].message).toContain('category');
    });

    it('search/facet-not-filterable — facetable + filterable produces no warning', () => {
      const config = makeConfig(
        'W1b',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          category: field.string(),
        },
        {
          fields: {
            title: {},
            category: { facetable: true, filterable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/facet-not-filterable');
      expect(matches.length).toBe(0);
    });

    it('search/no-filterable-fields — no fields are filterable', () => {
      const config = makeConfig(
        'W2',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: {
            title: { searchable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/no-filterable-fields');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('warning');
    });

    it('search/no-sortable-fields — no fields are sortable', () => {
      const config = makeConfig(
        'W3',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: {
            title: { searchable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/no-sortable-fields');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('warning');
    });
  });

  // -----------------------------------------------------------------------
  // Info
  // -----------------------------------------------------------------------

  describe('info', () => {
    it('search/no-facetable-fields — no facetable fields configured', () => {
      const config = makeConfig(
        'I1',
        {
          id: field.string({ primary: true }),
          title: field.string(),
        },
        {
          fields: {
            title: { searchable: true, filterable: true, sortable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/no-facetable-fields');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('info');
    });

    it('search/many-weighted-fields — more than 5 custom-weighted fields', () => {
      const config = makeConfig(
        'I2',
        {
          id: field.string({ primary: true }),
          f1: field.string(),
          f2: field.string(),
          f3: field.string(),
          f4: field.string(),
          f5: field.string(),
          f6: field.string(),
        },
        {
          fields: {
            f1: { weight: 10 },
            f2: { weight: 8 },
            f3: { weight: 6 },
            f4: { weight: 5 },
            f5: { weight: 3 },
            f6: { weight: 2 },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/many-weighted-fields');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('info');
    });

    it('search/many-weighted-fields — 5 or fewer weighted fields is fine', () => {
      const config = makeConfig(
        'I2b',
        {
          id: field.string({ primary: true }),
          f1: field.string(),
          f2: field.string(),
          f3: field.string(),
        },
        {
          fields: {
            f1: { weight: 10 },
            f2: { weight: 8 },
            f3: { weight: 6 },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/many-weighted-fields');
      expect(matches.length).toBe(0);
    });

    it('search/large-field-displayed — json field displayed by default', () => {
      const config = makeConfig(
        'I3',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          metadata: field.json(),
        },
        {
          fields: {
            title: { filterable: true, sortable: true },
            metadata: { searchable: false, filterable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/large-field-displayed');
      expect(matches.length).toBe(1);
      expect(matches[0].severity).toBe('info');
      expect(matches[0].message).toContain('metadata');
    });

    it('search/large-field-displayed — json field with displayed: false is fine', () => {
      const config = makeConfig(
        'I3b',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          metadata: field.json(),
        },
        {
          fields: {
            title: { filterable: true, sortable: true },
            metadata: { searchable: false, displayed: false },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/large-field-displayed');
      expect(matches.length).toBe(0);
    });

    it('search/large-field-displayed — string[] field displayed by default', () => {
      const config = makeConfig(
        'I3c',
        {
          id: field.string({ primary: true }),
          title: field.string(),
          tags: field.stringArray(),
        },
        {
          fields: {
            title: { filterable: true, sortable: true },
            tags: { filterable: true },
          },
        },
      );
      const findings = auditSearchConfig(config);
      const matches = findByRule(findings, 'search/large-field-displayed');
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain('tags');
    });
  });

  // -----------------------------------------------------------------------
  // No search config — no findings
  // -----------------------------------------------------------------------

  it('produces no search findings when entity has no search config', () => {
    const Entity = defineEntity('NoSearch', {
      fields: {
        id: field.string({ primary: true }),
        name: field.string(),
      },
    });
    const result = auditEntity(Entity);
    const searchFindings = result.findings.filter(f => f.rule.startsWith('search/'));
    expect(searchFindings.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Integration: wired into auditEntity
  // -----------------------------------------------------------------------

  it('auditEntity includes search findings when search config is present', () => {
    // Entity with search but no filterable/sortable/facetable fields → warnings + info
    const Entity = defineEntity('SearchInteg', {
      fields: {
        id: field.string({ primary: true }),
        title: field.string(),
      },
      search: {
        fields: {
          title: { searchable: true },
        },
      },
    });
    const result = auditEntity(Entity);
    const searchFindings = result.findings.filter(f => f.rule.startsWith('search/'));
    // Should include warnings for no-filterable, no-sortable, and info for no-facetable
    expect(searchFindings.length).toBeGreaterThan(0);
    expect(findByRule(result.findings, 'search/no-filterable-fields').length).toBe(1);
    expect(findByRule(result.findings, 'search/no-sortable-fields').length).toBe(1);
    expect(findByRule(result.findings, 'search/no-facetable-fields').length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Multiple errors at once
  // -----------------------------------------------------------------------

  it('reports multiple search errors in a single audit', () => {
    const config = makeConfig(
      'Multi',
      {
        id: field.string({ primary: true }),
        name: field.string(),
        lat: field.string(),
        lng: field.boolean(),
      },
      {
        fields: {
          name: { searchable: false },
          ghost: { searchable: false },
        },
        geo: { latField: 'lat', lngField: 'lng' },
        distinctField: 'missing',
      },
    );
    const findings = auditSearchConfig(config);
    const searchErrors = findings.filter(f => f.severity === 'error');
    // field-not-found (ghost), geo-not-numeric (lat, lng), distinct-not-found, no-searchable-fields
    expect(searchErrors.length).toBe(5);
  });
});
