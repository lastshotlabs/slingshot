import { describe, expect, test } from 'bun:test';
import {
  type StoreInfra,
  type TransactionOpConfig,
  defineEntity,
  field,
  index,
} from '@lastshotlabs/slingshot-core';
import { op } from '../../src/builders/op';
import {
  UnsupportedEntityBackendError,
  assertEntityBackendRequirements,
  resolveEntityBackendRequirements,
} from '../../src/configDriven/backendProfiles';
import { createCompositeFactories } from '../../src/configDriven/composition';
import { createEntityFactories } from '../../src/configDriven/createEntityFactories';

const BasicEntity = defineEntity('CapabilityBasic', {
  fields: {
    id: field.string({ primary: true }),
    value: field.string(),
  },
});

const UniqueEntity = defineEntity('CapabilityUnique', {
  fields: {
    id: field.string({ primary: true }),
    tenantId: field.string(),
    email: field.string(),
    slug: field.string(),
    deletedAt: field.date({ optional: true }),
  },
  indexes: [index(['email'], { unique: true })],
  uniques: [{ fields: ['tenantId', 'slug'] }],
  tenant: { field: 'tenantId' },
  softDelete: { field: 'deletedAt', strategy: 'non-null' },
  ttl: { defaultSeconds: 60 },
});

const unreachableInfra: StoreInfra = {
  appName: 'test',
  getRedis: () => {
    throw new Error('backend infrastructure must not be accessed');
  },
  getMongo: () => {
    throw new Error('backend infrastructure must not be accessed');
  },
  getSqliteDb: () => {
    throw new Error('backend infrastructure must not be accessed');
  },
  getPostgres: () => {
    throw new Error('backend infrastructure must not be accessed');
  },
};

describe('entity backend requirement derivation', () => {
  test('derives deterministic base and optional requirements from resolved config', () => {
    const requirements = resolveEntityBackendRequirements(UniqueEntity);
    expect(requirements).toContainEqual({
      capability: 'constraint.unique',
      requiredBy: 'unique index: email',
    });
    expect(requirements).toContainEqual({
      capability: 'constraint.unique',
      requiredBy: 'unique constraint: tenantId,slug',
    });
    expect(requirements).toContainEqual({
      capability: 'scope.tenant',
      requiredBy: 'tenant configuration',
    });
    expect(requirements).toContainEqual({
      capability: 'lifecycle.soft-delete',
      requiredBy: 'soft-delete configuration',
    });
    expect(requirements).toContainEqual({
      capability: 'lifecycle.ttl-visibility',
      requiredBy: 'TTL configuration',
    });
    expect(requirements.map(requirement => requirement.capability)).toContain('filter.or');
  });

  test('groups Redis uniqueness sources into one typed deterministic startup error', () => {
    try {
      assertEntityBackendRequirements('redis', UniqueEntity);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedEntityBackendError);
      expect(error).toMatchObject({
        code: 'SLINGSHOT_ENTITY_BACKEND_UNSUPPORTED',
        store: 'redis',
        entityName: 'CapabilityUnique',
        missing: [
          {
            capability: 'constraint.unique',
            requiredBy: ['unique constraint: tenantId,slug', 'unique index: email'],
          },
        ],
      });
      expect(String(error)).toContain('Redis does not maintain atomic secondary');
    }
  });

  test('validates before touching backend infrastructure', () => {
    let redisAccesses = 0;
    const infra = {
      getRedis() {
        redisAccesses += 1;
        throw new Error('getRedis must not run');
      },
    } as unknown as StoreInfra;

    expect(() => createEntityFactories(UniqueEntity).redis(infra)).toThrow(
      UnsupportedEntityBackendError,
    );
    expect(redisAccesses).toBe(0);
  });

  test('rejects composite-only operations passed to a single entity factory', () => {
    const factories = createEntityFactories(BasicEntity, {
      invalid: op.transaction({ steps: [] }),
    });
    expect(() => factories.memory()).toThrow(
      "operation 'invalid' uses composite-only kind 'transaction'",
    );
  });

  test('rejects a standard custom operation without an active-store factory', () => {
    expect(() =>
      createEntityFactories(BasicEntity, {
        externalOnly: op.custom({ http: { method: 'post' } }),
      }).memory(),
    ).toThrow(UnsupportedEntityBackendError);
  });

  test('preflights composite rollback support before constructing a child adapter', () => {
    let mongoAccesses = 0;
    const infra = {
      getMongo() {
        mongoAccesses += 1;
        throw new Error('getMongo must not run');
      },
    } as unknown as StoreInfra;
    const factories = createCompositeFactories(
      { records: { config: BasicEntity } },
      {
        write: op.transaction({
          steps: [{ op: 'create', entity: 'records', input: { id: 'param:id' } }],
        }),
      },
    );

    expect(() => factories.mongo(infra)).toThrow(UnsupportedEntityBackendError);
    expect(mongoAccesses).toBe(0);
  });

  test('rejects transaction steps that reference an unknown composite entity', () => {
    const factories = createCompositeFactories(
      { records: { config: BasicEntity } },
      {
        write: op.transaction({
          steps: [{ op: 'create', entity: 'missing', input: { id: 'param:id' } }],
        }),
      },
    );

    expect(() => factories.postgres(unreachableInfra)).toThrow(
      "step 0 references unknown entity 'missing'",
    );
  });

  test('rejects empty transactions before infrastructure access', () => {
    const factories = createCompositeFactories(
      { records: { config: BasicEntity } },
      { write: op.transaction({ steps: [] }) },
    );

    expect(() => factories.postgres(unreachableInfra)).toThrow(
      "transaction 'write' requires at least one step",
    );
  });

  test('rejects untyped illegal, missing, and unknown discriminant shapes deterministically', () => {
    const invalidOperations = [
      {
        expected: "contains illegal key 'set' for create",
        config: {
          kind: 'transaction',
          steps: [
            {
              op: 'create',
              entity: 'records',
              input: { id: 'param:id' },
              set: { value: 'param:value' },
            },
          ],
        },
      },
      {
        expected: "is missing required key 'match'",
        config: {
          kind: 'transaction',
          steps: [{ op: 'update', entity: 'records', set: { value: 'param:value' } }],
        },
      },
      {
        expected: "has unknown operation kind 'replace'",
        config: {
          kind: 'transaction',
          steps: [{ op: 'replace', entity: 'records', input: {} }],
        },
      },
    ] as const;

    for (const [index, invalid] of invalidOperations.entries()) {
      const factories = createCompositeFactories(
        { records: { config: BasicEntity } },
        { [`write${index}`]: invalid.config as unknown as TransactionOpConfig },
      );
      expect(() => factories.postgres(unreachableInfra)).toThrow(invalid.expected);
    }
  });

  test('rejects non-prior result bindings and unknown fields before infrastructure access', () => {
    const forwardReference = createCompositeFactories(
      { records: { config: BasicEntity } },
      {
        write: op.transaction({
          steps: [
            {
              op: 'create',
              entity: 'records',
              input: { id: 'param:id', value: { nested: 'result:0.value' } },
            },
          ],
        }),
      },
    );
    expect(() => forwardReference.postgres(unreachableInfra)).toThrow(
      'step 0 references non-prior result 0',
    );

    const unknownField = createCompositeFactories(
      { records: { config: BasicEntity } },
      {
        write: op.transaction({
          steps: [{ op: 'create', entity: 'records', input: { missing: 'param:value' } }],
        }),
      },
    );
    expect(() => unknownField.postgres(unreachableInfra)).toThrow(
      "step 0 references unknown field 'missing'",
    );
  });

  test('rejects a missing or mismatched named semantic operation before infrastructure access', () => {
    const factories = createCompositeFactories(
      {
        records: {
          config: BasicEntity,
          operations: {
            setValue: op.fieldUpdate({
              match: { id: 'param:id' },
              set: ['value'],
            }),
          },
        },
      },
      {
        write: op.transaction({
          steps: [
            {
              op: 'transition',
              entity: 'records',
              operation: 'setValue',
              match: { id: 'param:id' },
              field: 'value',
              from: 'before',
              to: 'after',
            },
          ],
        }),
      },
    );

    expect(() => factories.postgres(unreachableInfra)).toThrow(
      "requires named transition operation 'setValue'",
    );
  });
});
