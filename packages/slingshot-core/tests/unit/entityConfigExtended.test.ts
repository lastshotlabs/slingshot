import { describe, expect, test } from 'bun:test';
import { defineEntity, field, index, relation } from '../../src/entityConfig';

describe('field builders', () => {
  test('field.stringArray creates string[] type', () => {
    const f = field.stringArray();
    expect(f.type).toBe('string[]');
    expect(f.optional).toBe(false);
  });

  test('field.stringArray with optional', () => {
    const f = field.stringArray({ optional: true });
    expect(f.optional).toBe(true);
  });
});

describe('relation builders', () => {
  test('relation.belongsTo', () => {
    const r = relation.belongsTo('User', 'userId');
    expect(r.kind).toBe('belongsTo');
    expect(r.target).toBe('User');
    expect(r.foreignKey).toBe('userId');
  });

  test('relation.belongsTo with optional', () => {
    const r = relation.belongsTo('User', 'userId', { optional: true });
    expect(r.optional).toBe(true);
  });

  test('relation.hasMany', () => {
    const r = relation.hasMany('Comment', 'postId');
    expect(r.kind).toBe('hasMany');
    expect(r.target).toBe('Comment');
    expect(r.foreignKey).toBe('postId');
  });

  test('relation.hasOne', () => {
    const r = relation.hasOne('Profile', 'userId');
    expect(r.kind).toBe('hasOne');
    expect(r.target).toBe('Profile');
    expect(r.foreignKey).toBe('userId');
  });
});

describe('defineEntity validation', () => {
  const baseFields = {
    id: field.string({ primary: true, default: 'uuid' }),
    name: field.string(),
  };

  test('throws when no primary key', () => {
    expect(() =>
      defineEntity('Foo', { fields: { name: field.string() } }),
    ).toThrow('No primary key field defined');
  });

  test('throws when multiple primary keys', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: {
          id: field.string({ primary: true }),
          id2: field.string({ primary: true }),
        },
      }),
    ).toThrow('Multiple primary key fields');
  });

  test('throws when PK type is invalid (boolean)', () => {
    expect(() =>
      defineEntity('Foo', { fields: { id: field.boolean({ primary: true }) } }),
    ).toThrow('Primary key must be string, number, or integer');
  });

  test('throws when softDelete field not found', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        softDelete: { field: 'missing', value: 'deleted' },
      }),
    ).toThrow("softDelete.field 'missing' not found in fields");
  });

  test('throws when tenant field not found', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        tenant: { field: 'tenantId' },
      }),
    ).toThrow("tenant.field 'tenantId' not found in fields");
  });

  test('throws when index references unknown field', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        indexes: [index(['unknown'])],
      }),
    ).toThrow("Index references unknown field 'unknown'");
  });

  test('throws when pagination cursor references unknown field', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        pagination: { cursor: { fields: ['createdAt'] } },
      }),
    ).toThrow("pagination.cursor references unknown field 'createdAt'");
  });

  // --- Search validation ---
  test('throws when search.fields references unknown field', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        search: { fields: { unknown: { searchable: true } } },
      }),
    ).toThrow("search.fields references unknown field 'unknown'");
  });

  test('throws when no searchable field in search config', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        search: { fields: { name: { searchable: false } } },
      }),
    ).toThrow('at least one searchable field');
  });

  test('throws when search field weight is non-positive', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        search: { fields: { name: { weight: 0 } } },
      }),
    ).toThrow('weight must be positive');
  });

  test('throws when geo latField not found', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        search: {
          fields: { name: {} },
          geo: { latField: 'lat', lngField: 'lng' },
        },
      }),
    ).toThrow("search.geo.latField 'lat' not found");
  });

  test('throws when geo latField is not number type', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: { ...baseFields, lat: field.string(), lng: field.number() },
        search: {
          fields: { name: {} },
          geo: { latField: 'lat', lngField: 'lng' },
        },
      }),
    ).toThrow("search.geo.latField 'lat' must be type 'number'");
  });

  test('throws when geo lngField not found', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: { ...baseFields, lat: field.number() },
        search: {
          fields: { name: {} },
          geo: { latField: 'lat', lngField: 'lng' },
        },
      }),
    ).toThrow("search.geo.lngField 'lng' not found");
  });

  test('throws when geo lngField is not number type', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: { ...baseFields, lat: field.number(), lng: field.string() },
        search: {
          fields: { name: {} },
          geo: { latField: 'lat', lngField: 'lng' },
        },
      }),
    ).toThrow("search.geo.lngField 'lng' must be type 'number'");
  });

  test('throws when distinctField not found', () => {
    expect(() =>
      defineEntity('Foo', {
        fields: baseFields,
        search: { fields: { name: {} }, distinctField: 'missing' },
      }),
    ).toThrow("search.distinctField 'missing' not found");
  });
});

describe('defineEntity storage name derivation', () => {
  test('simple name pluralization', () => {
    const entity = defineEntity('Post', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('posts');
  });

  test('PascalCase to snake_case', () => {
    const entity = defineEntity('MyEntity', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('my_entities');
  });

  test('namespace prefix', () => {
    const entity = defineEntity('Message', {
      namespace: 'chat',
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('chat_messages');
  });

  test('y -> ies pluralization (consonant + y)', () => {
    const entity = defineEntity('Category', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('categories');
  });

  test('y stays y+s for vowel + y', () => {
    const entity = defineEntity('Day', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('days');
  });

  test('x -> xes pluralization', () => {
    const entity = defineEntity('Box', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('boxes');
  });

  test('s -> ses pluralization', () => {
    const entity = defineEntity('Status', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('statuses');
  });

  test('sh -> shes pluralization', () => {
    const entity = defineEntity('Crash', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('crashes');
  });

  test('ch -> ches pluralization', () => {
    const entity = defineEntity('Match', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('matches');
  });

  test('z -> zes pluralization', () => {
    const entity = defineEntity('Quiz', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(entity._storageName).toBe('quizes');
  });
});

describe('defineEntity valid configs (pass-through branches)', () => {
  test('valid tenant config passes', () => {
    const entity = defineEntity('Tenant', {
      fields: {
        id: field.string({ primary: true }),
        tenantId: field.string(),
      },
      tenant: { field: 'tenantId' },
    });
    expect(entity.tenant?.field).toBe('tenantId');
  });

  test('valid pagination cursor passes', () => {
    const entity = defineEntity('Paginated', {
      fields: {
        id: field.string({ primary: true }),
        createdAt: field.date({ default: 'now' }),
      },
      pagination: { cursor: { fields: ['createdAt', 'id'] } },
    });
    expect(entity.pagination?.cursor.fields).toEqual(['createdAt', 'id']);
  });

  test('valid index config passes', () => {
    const entity = defineEntity('Indexed', {
      fields: {
        id: field.string({ primary: true }),
        name: field.string(),
      },
      indexes: [index(['name'])],
    });
    expect(entity.indexes).toHaveLength(1);
  });

  test('valid search config with geo passes', () => {
    const entity = defineEntity('GeoEntity', {
      fields: {
        id: field.string({ primary: true }),
        name: field.string(),
        lat: field.number(),
        lng: field.number(),
      },
      search: {
        fields: { name: { searchable: true } },
        geo: { latField: 'lat', lngField: 'lng' },
      },
    });
    expect(entity.search?.geo?.latField).toBe('lat');
  });

  test('valid search config with distinctField passes', () => {
    const entity = defineEntity('Distinct', {
      fields: {
        id: field.string({ primary: true }),
        name: field.string(),
      },
      search: {
        fields: { name: { searchable: true } },
        distinctField: 'name',
      },
    });
    expect(entity.search?.distinctField).toBe('name');
  });

  test('valid softDelete config passes', () => {
    const entity = defineEntity('Soft', {
      fields: {
        id: field.string({ primary: true }),
        status: field.string(),
      },
      softDelete: { field: 'status', value: 'deleted' },
    });
    expect(entity.softDelete).toBeDefined();
  });
});

describe('defineEntity result', () => {
  test('sets _pkField', () => {
    const entity = defineEntity('Foo', {
      fields: { myId: field.string({ primary: true }) },
    });
    expect(entity._pkField).toBe('myId');
  });

  test('result is deeply frozen', () => {
    const entity = defineEntity('Foo', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(Object.isFrozen(entity)).toBe(true);
    expect(Object.isFrozen(entity.fields)).toBe(true);
  });

  test('integer primary key is valid', () => {
    const entity = defineEntity('Counter', {
      fields: { id: field.integer({ primary: true }) },
    });
    expect(entity._pkField).toBe('id');
  });

  test('number primary key is valid', () => {
    const entity = defineEntity('Metric', {
      fields: { id: field.number({ primary: true }) },
    });
    expect(entity._pkField).toBe('id');
  });
});
