import { describe, expect, test } from 'bun:test';
import {
  EntityConcurrencyConflictError,
  EntityConcurrencyPreconditionError,
  type InferCreateInput,
  type InferEntity,
  type InferUpdateInput,
  field as coreField,
  defineEntity as defineCoreEntity,
} from '@lastshotlabs/slingshot-core';
import { defineEntity, field } from '../../src';
import {
  ENTITY_BACKEND_PROFILES,
  resolveEntityBackendRequirements,
} from '../../src/configDriven/backendProfiles';

describe('optimistic concurrency contracts', () => {
  test('both definition paths inject and freeze identical resolved metadata', () => {
    for (const entity of [
      defineCoreEntity('CoreVersioned', {
        fields: { id: coreField.string({ primary: true }) },
        concurrency: { strategy: 'version' },
      }),
      defineEntity('DevVersioned', {
        fields: { id: field.string({ primary: true }) },
        concurrency: { strategy: 'version' },
      }),
    ]) {
      expect(entity._concurrency).toEqual({
        strategy: 'version',
        field: 'version',
        requiredOnWrite: true,
        initialVersion: 1,
      });
      expect(entity.fields.version).toMatchObject({
        type: 'number',
        default: 'version',
        optional: false,
        immutable: true,
        integer: true,
        min: 1,
      });
      expect(Object.isFrozen(entity._concurrency)).toBe(true);
      expect(Object.isFrozen(entity.fields.version)).toBe(true);
    }
  });

  test('resolves custom field names and rejects collisions', () => {
    const entity = defineEntity('Revisioned', {
      fields: { id: field.string({ primary: true }) },
      concurrency: { strategy: 'version', field: 'revision', requiredOnWrite: false },
    });
    expect(entity._concurrency?.field).toBe('revision');
    expect(entity._concurrency?.requiredOnWrite).toBe(false);
    expect(entity.fields.revision.default).toBe('version');

    const systemNamed = defineEntity('SystemRevisioned', {
      fields: {
        id: field.string({ primary: true }),
        version: field.string(),
      },
      systemFields: { version: 'rowRevision' },
      concurrency: { strategy: 'version' },
    });
    expect(systemNamed._concurrency?.field).toBe('rowRevision');
    expect(systemNamed.fields.rowRevision.default).toBe('version');

    expect(() =>
      defineEntity('Collision', {
        fields: {
          id: field.string({ primary: true }),
          version: field.number(),
        },
        concurrency: { strategy: 'version' },
      }),
    ).toThrow("concurrency field 'version' collides with a declared field");
  });

  test('requires unsupported concurrency capabilities before backend implementation', () => {
    const entity = defineEntity('Guarded', {
      fields: { id: field.string({ primary: true }) },
      concurrency: { strategy: 'version' },
    });
    expect(resolveEntityBackendRequirements(entity)).toEqual(
      expect.arrayContaining([
        {
          capability: 'concurrency.version-update',
          requiredBy: 'entity concurrency update',
        },
        {
          capability: 'concurrency.version-delete',
          requiredBy: 'entity concurrency delete',
        },
      ]),
    );
    expect(ENTITY_BACKEND_PROFILES.memory.capabilities['concurrency.version-update'].status).toBe(
      'supported',
    );
    expect(ENTITY_BACKEND_PROFILES.memory.capabilities['concurrency.version-delete'].status).toBe(
      'supported',
    );
    for (const profile of [
      ENTITY_BACKEND_PROFILES.sqlite,
      ENTITY_BACKEND_PROFILES.postgres,
      ENTITY_BACKEND_PROFILES.mongo,
      ENTITY_BACKEND_PROFILES.redis,
    ]) {
      expect(profile.capabilities['concurrency.version-update'].status).toBe('unsupported');
      expect(profile.capabilities['concurrency.version-delete'].status).toBe('unsupported');
    }
  });

  test('publishes stable transport-neutral errors', () => {
    expect(new EntityConcurrencyPreconditionError('Post', 'update')).toMatchObject({
      code: 'ENTITY_CONCURRENCY_PRECONDITION_REQUIRED',
      entity: 'Post',
      operation: 'update',
    });
    expect(new EntityConcurrencyConflictError('Post', 42, 7)).toMatchObject({
      code: 'ENTITY_CONCURRENCY_CONFLICT',
      entity: 'Post',
      id: 42,
      expectedVersion: 7,
    });
  });
});

const TypedVersioned = defineEntity('TypedVersioned', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
  },
  concurrency: { strategy: 'version' },
});
void TypedVersioned;

type VersionedRecord = InferEntity<typeof TypedVersioned.fields>;
type VersionedCreate = InferCreateInput<typeof TypedVersioned.fields>;
type VersionedUpdate = InferUpdateInput<typeof TypedVersioned.fields>;
type Assert<T extends true> = T;
type VersionExcludedFromCreate = Assert<'version' extends keyof VersionedCreate ? false : true>;
type VersionExcludedFromUpdate = Assert<'version' extends keyof VersionedUpdate ? false : true>;

const record: VersionedRecord = { id: 'one', title: 'Title', version: 1 };
const create: VersionedCreate = { title: 'Title' };
const update: VersionedUpdate = { title: 'Changed' };
void [record, create, update];
void (0 as unknown as VersionExcludedFromCreate);
void (0 as unknown as VersionExcludedFromUpdate);

// @ts-expect-error generated versions are immutable and excluded from update input
const invalidUpdate: VersionedUpdate = { version: 2 };
void invalidUpdate;
