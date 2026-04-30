/**
 * Entity config and operation validation tests.
 *
 * Exercises the Zod-based validation logic in `src/validation.ts` to ensure
 * that valid configs pass, each cross-field refinement catches its specific
 * invalid case, and edge cases on field type constraints are handled.
 */
import { describe, expect, test } from 'bun:test';
import { defineEntity, field, index, relation } from '@lastshotlabs/slingshot-core';
import { entityConfigSchema, validateEntityConfig, validateOperations } from '../../src/validation';

// ---------------------------------------------------------------------------
// Helpers — build minimal valid configs
// ---------------------------------------------------------------------------

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'TestEntity',
    fields: {
      id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
      title: { type: 'string', primary: false, immutable: false, optional: false },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid configs pass
// ---------------------------------------------------------------------------

describe('Entity validation — valid configs', () => {
  test('minimal valid config passes', () => {
    const result = validateEntityConfig(validConfig());
    expect(result.success).toBe(true);
  });

  test('config with all optional sections passes', () => {
    const result = validateEntityConfig(
      validConfig({
        namespace: 'app',
        indexes: [{ fields: ['title'], direction: 'asc' }],
        uniques: [{ fields: ['title'] }],
        softDelete: { field: 'title', strategy: 'non-null' },
        defaultSort: { field: 'title', direction: 'desc' },
        pagination: {
          cursor: { fields: ['id'] },
          defaultLimit: 25,
          maxLimit: 100,
        },
        tenant: { field: 'title' },
        ttl: { defaultSeconds: 3600 },
        storage: {
          memory: { maxEntries: 5000 },
          redis: { keyPrefix: 'test:' },
          sqlite: { tableName: 'test_entities' },
          postgres: { tableName: 'test_entities' },
          mongo: { collectionName: 'test_entities' },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  test('config with search section passes', () => {
    const result = validateEntityConfig(
      validConfig({
        fields: {
          id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
          title: { type: 'string', primary: false, immutable: false, optional: false },
          lat: { type: 'number', primary: false, immutable: false, optional: false },
          lng: { type: 'number', primary: false, immutable: false, optional: false },
        },
        search: {
          provider: 'meilisearch',
          fields: {
            title: { searchable: true, weight: 2 },
          },
          geo: { latField: 'lat', lngField: 'lng' },
          syncMode: 'write-through',
          distinctField: 'title',
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  test('defineEntity succeeds with valid config and returns resolved config', () => {
    const entity = defineEntity('Note', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        body: field.string(),
        createdAt: field.date({ default: 'now' }),
      },
    });
    expect(entity._pkField).toBe('id');
    expect(entity._storageName).toBe('notes');
    expect(entity.name).toBe('Note');
  });

  test('defineEntity derives correct pluralized storage name', () => {
    const category = defineEntity('Category', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
    });
    expect(category._storageName).toBe('categories');

    const bus = defineEntity('Bus', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        route: field.string(),
      },
    });
    expect(bus._storageName).toBe('buses');
  });

  test('defineEntity with namespace prefixes storage name', () => {
    const entity = defineEntity('Message', {
      namespace: 'chat',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        body: field.string(),
      },
    });
    expect(entity._storageName).toBe('chat_messages');
  });
});

// ---------------------------------------------------------------------------
// Primary key validation
// ---------------------------------------------------------------------------

describe('Entity validation — primary key rules', () => {
  test('rejects config with no primary key', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        id: { type: 'string', primary: false, immutable: false, optional: false },
      },
    });
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('No primary key'))).toBe(true);
  });

  test('rejects config with multiple primary keys', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false },
        code: { type: 'string', primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('Multiple primary key'))).toBe(true);
  });

  test('rejects boolean primary key', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        active: { type: 'boolean', primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('must be string, number, or integer')),
    ).toBe(true);
  });

  test('rejects date primary key', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        ts: { type: 'date', primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('must be string, number, or integer')),
    ).toBe(true);
  });

  test('accepts integer primary key', () => {
    const result = validateEntityConfig({
      name: 'IntPk',
      fields: {
        id: { type: 'integer', primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts number primary key', () => {
    const result = validateEntityConfig({
      name: 'NumPk',
      fields: {
        id: { type: 'number', primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-field reference checks
// ---------------------------------------------------------------------------

describe('Entity validation — cross-field references', () => {
  test('softDelete.field must exist in fields', () => {
    const result = validateEntityConfig(
      validConfig({
        softDelete: { field: 'deletedAt', strategy: 'non-null' },
      }),
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes("softDelete.field 'deletedAt'")),
    ).toBe(true);
  });

  test('tenant.field must exist in fields', () => {
    const result = validateEntityConfig(
      validConfig({
        tenant: { field: 'orgId' },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes("tenant.field 'orgId'"))).toBe(true);
  });

  test('defaultSort.field must exist in fields', () => {
    const result = validateEntityConfig(
      validConfig({
        defaultSort: { field: 'nonexistent', direction: 'asc' },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('defaultSort.field'))).toBe(true);
  });

  test('pagination.cursor.fields must exist in fields', () => {
    const result = validateEntityConfig(
      validConfig({
        pagination: { cursor: { fields: ['createdAt'] } },
      }),
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('pagination.cursor references unknown')),
    ).toBe(true);
  });

  test('index fields must exist in fields', () => {
    const result = validateEntityConfig(
      validConfig({
        indexes: [{ fields: ['ghost'] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('Index references unknown'))).toBe(
      true,
    );
  });

  test('unique constraint fields must exist in fields', () => {
    const result = validateEntityConfig(
      validConfig({
        uniques: [{ fields: ['phantom'] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('Unique constraint references unknown')),
    ).toBe(true);
  });

  test('unique constraint rejects duplicate fields', () => {
    const result = validateEntityConfig(
      validConfig({
        uniques: [{ fields: ['title', 'title'] }],
      }),
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('Unique constraint has duplicate')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-default type constraints
// ---------------------------------------------------------------------------

describe('Entity validation — auto-default type constraints', () => {
  test('uuid default on non-string field is rejected', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        id: { type: 'integer', primary: true, immutable: true, optional: false, default: 'uuid' },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('only string fields support UUID/CUID')),
    ).toBe(true);
  });

  test('cuid default on non-string field is rejected', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        id: { type: 'number', primary: true, immutable: true, optional: false, default: 'cuid' },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('only string fields support UUID/CUID')),
    ).toBe(true);
  });

  test('now default on non-date field is rejected', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
        count: {
          type: 'integer',
          primary: false,
          immutable: false,
          optional: false,
          default: 'now',
        },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes("only date fields support 'now'")),
    ).toBe(true);
  });

  test('onUpdate: now on non-date field is rejected', () => {
    const result = validateEntityConfig({
      name: 'Bad',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
        name: {
          type: 'string',
          primary: false,
          immutable: false,
          optional: false,
          onUpdate: 'now',
        },
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('only date fields support onUpdate')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Search config validation
// ---------------------------------------------------------------------------

describe('Entity validation — search config', () => {
  test('search field referencing unknown entity field is rejected', () => {
    const result = validateEntityConfig(
      validConfig({
        search: {
          fields: {
            ghost: { searchable: true },
          },
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes("search.fields['ghost']"))).toBe(
      true,
    );
  });

  test('geo field referencing unknown field is rejected', () => {
    const result = validateEntityConfig(
      validConfig({
        search: {
          fields: {},
          geo: { latField: 'lat', lngField: 'lng' },
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes("search.geo.latField 'lat'"))).toBe(
      true,
    );
  });

  test('geo field that is not numeric is rejected', () => {
    const result = validateEntityConfig({
      name: 'GeoTest',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
        lat: { type: 'string', primary: false, immutable: false, optional: false },
        lng: { type: 'number', primary: false, immutable: false, optional: false },
      },
      search: {
        fields: {},
        geo: { latField: 'lat', lngField: 'lng' },
      },
    });
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes("must be type 'number'"))).toBe(true);
  });

  test('distinctField referencing unknown field is rejected', () => {
    const result = validateEntityConfig(
      validConfig({
        search: {
          fields: { title: { searchable: true } },
          distinctField: 'nonexistent',
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('search.distinctField'))).toBe(true);
  });

  test('tenantField with tenantIsolation referencing unknown field is rejected', () => {
    const result = validateEntityConfig(
      validConfig({
        search: {
          fields: { title: { searchable: true } },
          tenantIsolation: 'filtered',
          tenantField: 'orgId',
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('search.tenantField'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routes cross-field validation
// ---------------------------------------------------------------------------

describe('Entity validation — routes cross-field', () => {
  test('dataScope referencing unknown field is rejected', () => {
    const result = validateEntityConfig(
      validConfig({
        routes: {
          defaults: { auth: 'userAuth' },
          dataScope: { field: 'orgId', from: 'ctx:actor.tenantId' },
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('orgId'))).toBe(true);
  });

  test('disable referencing unknown operation is rejected', () => {
    const result = validateEntityConfig(
      validConfig({
        routes: {
          disable: ['bogusOp'],
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('routes.disable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Operation config validation
// ---------------------------------------------------------------------------

describe('Operation validation — field references', () => {
  const fieldNames = ['id', 'status', 'userId', 'email', 'count', 'items', 'expiresAt'];

  test('valid operations pass', () => {
    const result = validateOperations(
      {
        changeStatus: { kind: 'transition', field: 'status' },
        search: { kind: 'search', fields: ['email'] },
        byUser: { kind: 'fieldUpdate', set: ['status'] },
      },
      fieldNames,
    );
    expect(result.success).toBe(true);
  });

  test('transition referencing unknown field is rejected', () => {
    const result = validateOperations(
      { movePhase: { kind: 'transition', field: 'phase' } },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes("transition.field 'phase'"))).toBe(
      true,
    );
  });

  test('fieldUpdate referencing unknown field is rejected', () => {
    const result = validateOperations(
      { setFoo: { kind: 'fieldUpdate', set: ['foo'] } },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('fieldUpdate.set references unknown')),
    ).toBe(true);
  });

  test('search referencing unknown field is rejected', () => {
    const result = validateOperations({ find: { kind: 'search', fields: ['ghost'] } }, fieldNames);
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('search.fields references unknown')),
    ).toBe(true);
  });

  test('upsert with unknown match field is rejected', () => {
    const result = validateOperations(
      { upsertX: { kind: 'upsert', match: ['nonexistent'], set: ['status'] } },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('upsert.match references unknown')),
    ).toBe(true);
  });

  test('upsert with unknown set field is rejected', () => {
    const result = validateOperations(
      { upsertX: { kind: 'upsert', match: ['email'], set: ['missing'] } },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('upsert.set references unknown')),
    ).toBe(true);
  });

  test('aggregate with unknown groupBy field is rejected', () => {
    const result = validateOperations(
      { stats: { kind: 'aggregate', groupBy: 'region' } },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('aggregate.groupBy references unknown')),
    ).toBe(true);
  });

  test('aggregate with object groupBy referencing unknown field is rejected', () => {
    const result = validateOperations(
      { stats: { kind: 'aggregate', groupBy: { field: 'region' } } },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes('aggregate.groupBy references unknown')),
    ).toBe(true);
  });

  test('collection with unknown parentKey is rejected', () => {
    const result = validateOperations(
      {
        attachments: {
          kind: 'collection',
          parentKey: 'postId',
          operations: ['list', 'add'],
          itemFields: { url: 'string' },
        },
      },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes("collection.parentKey 'postId'")),
    ).toBe(true);
  });

  test('collection needing identifyBy for update/remove is rejected without it', () => {
    const result = validateOperations(
      {
        tags: {
          kind: 'collection',
          parentKey: 'userId',
          operations: ['list', 'update'],
          itemFields: { label: 'string' },
        },
      },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes("needs 'identifyBy'"))).toBe(true);
  });

  test('consume.expiry.field referencing unknown field is rejected', () => {
    const result = validateOperations(
      {
        useToken: {
          kind: 'consume',
          expiry: { field: 'expAt' },
        },
      },
      fieldNames,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors!.issues.some(i => i.message.includes("consume.expiry.field 'expAt'")),
    ).toBe(true);
  });

  test('consume.expiry.field referencing valid field passes', () => {
    const result = validateOperations(
      {
        useToken: {
          kind: 'consume',
          expiry: { field: 'expiresAt' },
        },
      },
      fieldNames,
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Entity validation — edge cases', () => {
  test('empty name is rejected', () => {
    const result = validateEntityConfig({
      name: '',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(false);
  });

  test('empty fields object fails (no primary key)', () => {
    const result = validateEntityConfig({
      name: 'Empty',
      fields: {},
    });
    expect(result.success).toBe(false);
    expect(result.errors!.issues.some(i => i.message.includes('No primary key'))).toBe(true);
  });

  test('defineEntity throws on invalid config', () => {
    expect(() => {
      defineEntity('Bad', {
        fields: {
          // No primary key
          name: field.string(),
        },
      });
    }).toThrow(/No primary key/);
  });

  test('multiple validation issues are all reported', () => {
    const result = validateEntityConfig({
      name: 'Multi',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false },
      },
      softDelete: { field: 'deletedAt', strategy: 'non-null' },
      tenant: { field: 'orgId' },
      defaultSort: { field: 'createdAt', direction: 'asc' },
    });
    expect(result.success).toBe(false);
    // Should report all three missing field references
    expect(result.errors!.issues.length).toBeGreaterThanOrEqual(3);
  });

  test('field types are validated (invalid type rejected)', () => {
    const result = validateEntityConfig({
      name: 'BadType',
      fields: {
        id: { type: 'bigint' as any, primary: true, immutable: true, optional: false },
      },
    });
    expect(result.success).toBe(false);
  });
});
