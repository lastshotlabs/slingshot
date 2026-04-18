/**
 * manifestToEntity — JSON → ResolvedEntityConfig conversion tests.
 *
 * Verifies conversion produces the same result as TypeScript defineEntity()
 * and that generate() output is compatible.
 */
import { describe, expect, it } from 'bun:test';
import { generate } from '../../src/generate';
import type { ManifestEntity } from '../../src/index';
import {
  createEntityHandlerRegistry,
  manifestEntitiesToConfigs,
  manifestToEntity,
} from '../../src/index';
import { defineEntity, field } from '../../src/index';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const userEntityDef: ManifestEntity = {
  namespace: 'accounts',
  fields: {
    id: { type: 'string', primary: true, default: 'uuid' },
    email: { type: 'string' },
    role: { type: 'enum', values: ['admin', 'user', 'guest'], default: 'user' },
    createdAt: { type: 'date', default: 'now' },
  },
  indexes: [{ fields: ['email'], unique: true }],
  operations: {
    byEmail: { kind: 'lookup', fields: { email: 'param:email' }, returns: 'one' },
  },
};

// ---------------------------------------------------------------------------
// manifestToEntity — single entity
// ---------------------------------------------------------------------------

describe('manifestToEntity', () => {
  it('converts entity definition to ResolvedEntityConfig', () => {
    const { config } = manifestToEntity('User', userEntityDef);
    expect(config.name).toBe('User');
    expect(config._pkField).toBe('id');
    expect(config._storageName).toBe('accounts_users');
    expect(config.fields.id.primary).toBe(true);
    expect(config.fields.role.enumValues).toEqual(['admin', 'user', 'guest']);
  });

  it('preserves field format metadata', () => {
    const def: ManifestEntity = {
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        email: { type: 'string', format: 'email' },
      },
    };
    const { config } = manifestToEntity('Contact', def);
    expect(config.fields.email.format).toBe('email');
  });

  it('applies namespace to storage name', () => {
    const { config } = manifestToEntity('User', userEntityDef);
    expect(config.namespace).toBe('accounts');
    expect(config._storageName).toBe('accounts_users');
  });

  it('produces storage name without namespace', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
    };
    const { config } = manifestToEntity('Item', def);
    expect(config._storageName).toBe('items');
  });

  it('converts operations', () => {
    const { operations } = manifestToEntity('User', userEntityDef);
    expect(Object.keys(operations!)).toContain('byEmail');
    expect(operations!.byEmail.kind).toBe('lookup');
  });

  it('preserves custom operation http metadata when resolving handler refs', () => {
    const entityDef: ManifestEntity = {
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
      },
      operations: {
        redeemInvite: {
          kind: 'custom',
          handler: 'chat.invite.redeem',
          http: { method: 'post', path: 'redeem' },
        },
      },
    };
    const registry = createEntityHandlerRegistry();
    registry.register('chat.invite.redeem', () => () => () => Promise.resolve({ ok: true }));

    const { operations } = manifestToEntity('RoomInvite', entityDef, registry);
    const redeemInvite = operations?.redeemInvite;
    expect(redeemInvite?.kind).toBe('custom');
    expect(redeemInvite && 'http' in redeemInvite ? redeemInvite.http : undefined).toEqual({
      method: 'post',
      path: 'redeem',
    });
  });

  it('returns undefined operations when entity has none', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
    };
    const result = manifestToEntity('Empty', def);
    expect(result.operations).toBeUndefined();
  });

  it('validates raw input before conversion (Zod parse)', () => {
    const invalidInput = { fields: { id: { type: 'bad_type', primary: true } } };
    expect(() => manifestToEntity('Bad', invalidInput as ManifestEntity)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Parity with TypeScript defineEntity() + generate()
// ---------------------------------------------------------------------------

describe('manifestToEntity — parity with defineEntity()', () => {
  it('produces same _storageName as TypeScript path', () => {
    const tsEntity = defineEntity('Order', {
      namespace: 'shop',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        total: field.number({ default: 0 }),
        month: field.string({ format: 'month' }),
        createdAt: field.date({ default: 'now' }),
      },
    });

    const jsonDef: ManifestEntity = {
      namespace: 'shop',
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        total: { type: 'number', default: 0 },
        month: { type: 'string', format: 'month' },
        createdAt: { type: 'date', default: 'now' },
      },
    };
    const { config: jsonConfig } = manifestToEntity('Order', jsonDef);

    expect(jsonConfig._storageName).toBe(tsEntity._storageName);
    expect(jsonConfig.name).toBe(tsEntity.name);
    expect(jsonConfig.namespace).toBe(tsEntity.namespace);
    expect(jsonConfig._pkField).toBe(tsEntity._pkField);
  });

  it('generate() produces byte-identical output from JSON and TypeScript paths', () => {
    const tsEntity = defineEntity('Widget', {
      namespace: 'shop',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        label: field.string(),
        price: field.number({ default: 0 }),
        createdAt: field.date({ default: 'now' }),
      },
      indexes: [{ fields: ['label'], unique: true }],
    });

    const jsonDef: ManifestEntity = {
      namespace: 'shop',
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        label: { type: 'string' },
        price: { type: 'number', default: 0 },
        createdAt: { type: 'date', default: 'now' },
      },
      indexes: [{ fields: ['label'], unique: true }],
    };
    const { config: jsonConfig } = manifestToEntity('Widget', jsonDef);

    const backends = ['sqlite', 'postgres', 'mongo', 'memory'] as const;
    const tsFiles = generate(tsEntity, { backends: [...backends] });
    const jsonFiles = generate(
      jsonConfig as unknown as import('../../src/types').ResolvedEntityConfig,
      { backends: [...backends] },
    );

    // Keys must match
    expect(Object.keys(jsonFiles).sort()).toEqual(Object.keys(tsFiles).sort());

    // Content must match byte-for-byte: the two paths produce identical entity
    // configs, so their generated source should be indistinguishable.
    for (const key of Object.keys(tsFiles)) {
      expect(jsonFiles[key]).toBe(tsFiles[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// manifestEntitiesToConfigs — bulk conversion
// ---------------------------------------------------------------------------

describe('manifestEntitiesToConfigs', () => {
  it('converts all entities in a record', () => {
    const postDef: ManifestEntity = {
      namespace: 'blog',
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        title: { type: 'string' },
      },
    };
    const { entities } = manifestEntitiesToConfigs({ User: userEntityDef, Post: postDef });
    expect(Object.keys(entities)).toEqual(['User', 'Post']);
    expect(entities.User.config.name).toBe('User');
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
});
