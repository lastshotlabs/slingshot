import { describe, expect, it } from 'bun:test';
import type { ManifestEntities, ManifestEntity } from '../../packages/slingshot-entity/src/index';
import {
  manifestEntitiesSchema,
  manifestEntitiesToConfigs,
  manifestEntitySchema,
  manifestToEntity,
} from '../../packages/slingshot-entity/src/index';
import { validateAppManifest } from '../../src/lib/manifest';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const userEntityDef: ManifestEntity = {
  fields: {
    id: { type: 'string', primary: true, default: 'uuid' },
    email: { type: 'string' },
    role: { type: 'enum', values: ['admin', 'user', 'guest'], default: 'user' },
    createdAt: { type: 'date', default: 'now' },
  },
  indexes: [{ fields: ['email'], unique: true }],
  routes: { disable: ['delete'] },
  pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 20, maxLimit: 100 },
  operations: {
    byEmail: { kind: 'lookup', fields: { email: 'param:email' }, returns: 'one' },
    promoteToAdmin: {
      kind: 'transition',
      field: 'role',
      from: 'user',
      to: 'admin',
      match: { id: 'param:id' },
    },
  },
};

const postEntityDef: ManifestEntity = {
  namespace: 'blog',
  fields: {
    id: { type: 'string', primary: true, default: 'uuid' },
    authorId: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'enum', values: ['draft', 'published', 'archived'], default: 'draft' },
    publishedAt: { type: 'date', optional: true },
  },
  softDelete: { field: 'status', value: 'archived' },
  operations: {
    publish: {
      kind: 'transition',
      field: 'status',
      from: 'draft',
      to: 'published',
      match: { id: 'param:id' },
    },
    byAuthor: { kind: 'lookup', fields: { authorId: 'param:authorId' }, returns: 'many' },
  },
};

// ---------------------------------------------------------------------------
// manifestEntitySchema — single entity validation
// ---------------------------------------------------------------------------

describe('manifestEntitySchema', () => {
  it('validates a well-formed entity definition', () => {
    const result = manifestEntitySchema.safeParse(userEntityDef);
    expect(result.success).toBe(true);
  });

  it('rejects unknown field type', () => {
    const result = manifestEntitySchema.safeParse({
      fields: { id: { type: 'uuid', primary: true } }, // 'uuid' is not a valid type
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown operation kind', () => {
    const result = manifestEntitySchema.safeParse({
      fields: { id: { type: 'string', primary: true } },
      operations: { bad: { kind: 'nonexistent' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts all supported field types', () => {
    const result = manifestEntitySchema.safeParse({
      fields: {
        id: { type: 'string', primary: true },
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'integer' },
        d: { type: 'boolean' },
        e: { type: 'date' },
        f: { type: 'json' },
        g: { type: 'string[]' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts enum field with values', () => {
    const result = manifestEntitySchema.safeParse({
      fields: {
        id: { type: 'string', primary: true },
        status: { type: 'enum', values: ['active', 'inactive'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all built-in operation kinds', () => {
    const result = manifestEntitySchema.safeParse({
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        name: { type: 'string' },
        status: { type: 'enum', values: ['a', 'b'] },
      },
      operations: {
        op1: { kind: 'lookup', fields: { name: 'param:name' }, returns: 'one' },
        op2: { kind: 'exists', fields: { id: 'param:id' } },
        op3: {
          kind: 'transition',
          field: 'status',
          from: 'a',
          to: 'b',
          match: { id: 'param:id' },
        },
        op4: { kind: 'fieldUpdate', match: { id: 'param:id' }, set: ['name'] },
        op5: { kind: 'aggregate', compute: { count: 'count' } },
        op6: { kind: 'batch', action: 'delete', filter: { name: 'param:name' } },
        op7: { kind: 'upsert', match: ['name'], set: ['name'] },
        op8: { kind: 'search', fields: ['name'] },
        op9: { kind: 'consume', filter: { id: 'param:id' }, returns: 'boolean' },
        op10: {
          kind: 'derive',
          sources: [{ from: 'Test', where: { id: 'param:id' } }],
          merge: 'concat',
        },
        op11: {
          kind: 'collection',
          parentKey: 'id',
          itemFields: { tag: { type: 'string' } },
          operations: ['list', 'add'],
        },
        op12: { kind: 'custom', handler: 'my-handler' },
        op13: {
          kind: 'computedAggregate',
          source: 'Other',
          target: 'Test',
          sourceFilter: { tenantId: 'context:tenantId' },
          compute: { total: 'sum:amount' },
          materializeTo: 'total',
          targetMatch: { id: 'param:id' },
        },
        op14: {
          kind: 'transaction',
          steps: [
            { op: 'create', entity: 'Test', input: { name: 'x' } },
            { op: 'update', entity: 'Test', match: { id: 'param:id' }, set: { status: 'b' } },
          ],
        },
        op15: {
          kind: 'pipe',
          steps: [
            { op: 'search', config: { fields: ['name'] } },
            { op: 'aggregate', config: { compute: { count: 'count' } } },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts entity with namespace', () => {
    const result = manifestEntitySchema.safeParse({
      namespace: 'auth',
      fields: { id: { type: 'string', primary: true } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts field with optional, immutable, default, and onUpdate attributes', () => {
    const result = manifestEntitySchema.safeParse({
      fields: {
        id: { type: 'string', primary: true, default: 'uuid', immutable: true },
        name: { type: 'string', optional: true },
        createdAt: { type: 'date', default: 'now', immutable: true },
        updatedAt: { type: 'date', onUpdate: 'now' },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// manifestEntitiesSchema — multi-entity record validation
// ---------------------------------------------------------------------------

describe('manifestEntitiesSchema', () => {
  it('validates a record of entity definitions', () => {
    const entities: ManifestEntities = { User: userEntityDef, Post: postEntityDef };
    const result = manifestEntitiesSchema.safeParse(entities);
    expect(result.success).toBe(true);
  });

  it('rejects when any entity has an invalid field type', () => {
    const result = manifestEntitiesSchema.safeParse({
      User: userEntityDef,
      Bad: { fields: { id: { type: 'invalid', primary: true } } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty record', () => {
    const result = manifestEntitiesSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// manifestToEntity — single entity conversion
// ---------------------------------------------------------------------------

describe('manifestToEntity', () => {
  it('converts entity definition to ResolvedEntityConfig', () => {
    const { config } = manifestToEntity('User', userEntityDef);
    expect(config.name).toBe('User');
    expect(config._pkField).toBe('id');
    expect(config._storageName).toBe('users');
    expect(config.fields.id.primary).toBe(true);
    expect(config.fields.role.enumValues).toEqual(['admin', 'user', 'guest']);
    expect((config as { routes?: { disable?: string[] } }).routes?.disable).toEqual(['delete']);
  });

  it('applies namespace to storage name', () => {
    const { config } = manifestToEntity('Post', postEntityDef);
    expect(config.namespace).toBe('blog');
    expect(config._storageName).toBe('blog_posts');
  });

  it('converts operations', () => {
    const { operations } = manifestToEntity('User', userEntityDef);
    expect(Object.keys(operations!)).toContain('byEmail');
    expect(Object.keys(operations!)).toContain('promoteToAdmin');
    expect(operations!.byEmail.kind).toBe('lookup');
    expect(operations!.promoteToAdmin.kind).toBe('transition');
  });

  it('throws on missing primary key', () => {
    const noPk: ManifestEntity = { fields: { name: { type: 'string' } } };
    expect(() => manifestToEntity('Bad', noPk)).toThrow('No primary key');
  });

  it('throws on multiple primary keys', () => {
    const multiPk: ManifestEntity = {
      fields: {
        id: { type: 'string', primary: true },
        altId: { type: 'string', primary: true },
      },
    };
    expect(() => manifestToEntity('Bad', multiPk)).toThrow('Multiple primary key');
  });

  it('throws on invalid primary key type', () => {
    const boolPk: ManifestEntity = { fields: { id: { type: 'boolean', primary: true } } };
    expect(() => manifestToEntity('Bad', boolPk)).toThrow('must be string, number, or integer');
  });

  it('throws on softDelete referencing nonexistent field', () => {
    const badSoftDelete: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      softDelete: { field: 'nonexistent', value: 'deleted' },
    };
    expect(() => manifestToEntity('Bad', badSoftDelete)).toThrow(
      "softDelete.field 'nonexistent' not found",
    );
  });

  it('throws on index referencing unknown field', () => {
    const badIndex: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      indexes: [{ fields: ['nonexistent'] }],
    };
    expect(() => manifestToEntity('Bad', badIndex)).toThrow(
      "Index references unknown field 'nonexistent'",
    );
  });

  it('throws on operation referencing unknown field', () => {
    const badOp: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      operations: { bad: { kind: 'search', fields: ['nonexistent'] } },
    };
    expect(() => manifestToEntity('Bad', badOp)).toThrow("references unknown field 'nonexistent'");
  });

  it('validates raw input before conversion (Zod parse)', () => {
    const invalidInput = { fields: { id: { type: 'bad_type', primary: true } } };
    expect(() => manifestToEntity('Bad', invalidInput as ManifestEntity)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// manifestEntitiesToConfigs — bulk conversion
// ---------------------------------------------------------------------------

describe('manifestEntitiesToConfigs', () => {
  it('converts all entities in a record', () => {
    const { entities } = manifestEntitiesToConfigs({ User: userEntityDef, Post: postEntityDef });
    expect(Object.keys(entities)).toEqual(['User', 'Post']);
    expect(entities.User.config.name).toBe('User');
    expect(entities.User.config._pkField).toBe('id');
    expect(entities.Post.config.name).toBe('Post');
    expect(entities.Post.config.namespace).toBe('blog');
  });

  it('returns empty result for empty input', () => {
    const { entities } = manifestEntitiesToConfigs({});
    expect(Object.keys(entities)).toHaveLength(0);
  });

  it('throws when any entity fails validation', () => {
    const invalid = { fields: { id: { type: 'bad_type', primary: true } } };
    expect(() =>
      manifestEntitiesToConfigs({ User: userEntityDef, Bad: invalid as ManifestEntity }),
    ).toThrow();
  });

  it('each converted entity has expected operations', () => {
    const { entities } = manifestEntitiesToConfigs({ User: userEntityDef });
    expect(entities.User.operations!.byEmail.kind).toBe('lookup');
    expect(entities.User.operations!.promoteToAdmin.kind).toBe('transition');
  });
});

// ---------------------------------------------------------------------------
// App manifest schema — entities section integration
// ---------------------------------------------------------------------------

describe('App manifest schema — entities section', () => {
  it('validates app manifest with entities section', () => {
    const result = validateAppManifest({
      manifestVersion: 1,
      routesDir: '/app/routes',
      entities: { User: userEntityDef, Post: postEntityDef },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.entities).toBeDefined();
      expect(Object.keys(result.manifest.entities!)).toEqual(['User', 'Post']);
    }
  });

  it('validates app manifest without entities section', () => {
    const result = validateAppManifest({ manifestVersion: 1, routesDir: '/app/routes' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.entities).toBeUndefined();
    }
  });

  it('rejects app manifest with invalid entity field type', () => {
    const result = validateAppManifest({
      manifestVersion: 1,
      routesDir: '/app/routes',
      entities: { Bad: { fields: { id: { type: 'invalid_type', primary: true } } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('entities'))).toBe(true);
    }
  });

  it('rejects app manifest with invalid operation kind', () => {
    const result = validateAppManifest({
      manifestVersion: 1,
      routesDir: '/app/routes',
      entities: {
        Bad: {
          fields: { id: { type: 'string', primary: true } },
          operations: { bad: { kind: 'nonexistent_op' } },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('validates app manifest with entities alongside other config sections', () => {
    const result = validateAppManifest({
      manifestVersion: 1,
      routesDir: '/app/routes',
      meta: { name: 'my-app', version: '1.0.0' },
      db: { sqlite: ':memory:' },
      entities: { User: userEntityDef },
      port: 3000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.meta?.name).toBe('my-app');
      expect(result.manifest.entities).toBeDefined();
      expect(result.manifest.port).toBe(3000);
    }
  });

  it('validates app manifest tenancy discovery metadata', () => {
    const result = validateAppManifest({
      manifestVersion: 1,
      routesDir: '/app/routes',
      tenancy: {
        resolution: 'header',
        headerName: 'x-ledger-id',
        listEndpoint: '/api/tenants',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.tenancy?.listEndpoint).toBe('/api/tenants');
    }
  });

  it('rejects app manifest with wrong manifestVersion', () => {
    const result = validateAppManifest({ manifestVersion: 2, routesDir: '/app/routes' });
    expect(result.success).toBe(false);
  });

  it('accepts app manifest without routesDir (routesDir is optional)', () => {
    const result = validateAppManifest({ manifestVersion: 1 });
    expect(result.success).toBe(true);
  });

  it('produces unix+port conflict warning', () => {
    const result = validateAppManifest({
      manifestVersion: 1,
      routesDir: '/app/routes',
      unix: '/tmp/app.sock',
      port: 3000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warnings).toContain(
        'unix and port are mutually exclusive — port will be ignored',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Generate output parity — manifest vs TypeScript builder
// ---------------------------------------------------------------------------

describe('Manifest/Builder generate output parity', () => {
  it('manifestToEntity produces config compatible with createMemoryEntityAdapter', async () => {
    const { createMemoryEntityAdapter } = await import('@lastshotlabs/slingshot-entity');

    type UserRecord = { id: string; email: string; role: string; createdAt: Date };
    type UserCreate = { email: string; role?: string };
    type UserUpdate = { email?: string; role?: string };

    const { config, operations } = manifestToEntity('User', userEntityDef);
    const adapter = createMemoryEntityAdapter<UserRecord, UserCreate, UserUpdate>(
      config,
      operations,
    );

    const created = await adapter.create({ email: 'test@example.com' });
    expect(created.id).toBeDefined();
    expect(created.email).toBe('test@example.com');
    expect(created.role).toBe('user'); // default applied
  });
});
