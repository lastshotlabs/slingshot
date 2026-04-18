import { describe, expect, test } from 'bun:test';
import { createEntityRegistry, defineEntity, field } from '@lastshotlabs/slingshot-core';
import type { EntityRegistry } from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import {
  type FrameworkStoreInfra,
  REGISTER_ENTITY,
} from '../../src/framework/persistence/internalRepoResolution';

/**
 * Minimal StoreInfra stub that only implements the REGISTER_ENTITY hook.
 * Used to verify that createEntityFactories registers entities through
 * the symbol-keyed method on the infra object.
 */
function createStubInfra(entityRegistry: EntityRegistry): FrameworkStoreInfra {
  const registered = new Set<string>();

  return {
    appName: 'test',
    getRedis: () => {
      throw new Error('not configured');
    },
    getMongo: () => {
      throw new Error('not configured');
    },
    getSqliteDb: () => {
      throw new Error('not configured');
    },
    getPostgres: () => {
      throw new Error('not configured');
    },
    [REGISTER_ENTITY](config) {
      if (registered.has(config._storageName)) return;
      entityRegistry.register(config);
      registered.add(config._storageName);
    },
  };
}

const SearchablePost = defineEntity('SearchablePost', {
  namespace: 'blog',
  fields: {
    id: field.string({ primary: true }),
    title: field.string(),
    body: field.string(),
  },
  search: {
    fields: {
      title: { searchable: true },
      body: { searchable: true },
    },
  },
});

const PlainEntity = defineEntity('PlainEntity', {
  namespace: 'misc',
  fields: {
    id: field.string({ primary: true }),
    value: field.string(),
  },
});

describe('createEntityFactories → REGISTER_ENTITY → entityRegistry', () => {
  test('resolving a memory factory with FrameworkStoreInfra registers the entity', () => {
    const registry = createEntityRegistry();
    const infra = createStubInfra(registry);
    const factories = createEntityFactories(SearchablePost);

    // Resolve the memory adapter — this triggers maybeRegisterEntity
    factories.memory(infra);

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]._storageName).toBe('blog_searchable_posts');
    expect(all[0].search).toBeDefined();
  });

  test('entity without search config is still registered in the registry', () => {
    const registry = createEntityRegistry();
    const infra = createStubInfra(registry);
    const factories = createEntityFactories(PlainEntity);

    factories.memory(infra);

    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]._storageName).toBe('misc_plain_entities');
    expect(all[0].search).toBeUndefined();
  });

  test('duplicate registration is idempotent', () => {
    const registry = createEntityRegistry();
    const infra = createStubInfra(registry);
    const factories = createEntityFactories(SearchablePost);

    // Resolve twice — should not throw
    factories.memory(infra);
    factories.memory(infra);

    expect(registry.getAll()).toHaveLength(1);
  });

  test('searchable entities are discoverable via registry.filter after factory resolution', () => {
    const registry = createEntityRegistry();
    const infra = createStubInfra(registry);

    createEntityFactories(SearchablePost).memory(infra);
    createEntityFactories(PlainEntity).memory(infra);

    const searchable = registry.filter(e => !!e.search);
    expect(searchable).toHaveLength(1);
    expect(searchable[0].name).toBe('SearchablePost');
  });
});
