import { describe, expect, it } from 'bun:test';
import { field } from '../../src/builders/field';
import { op } from '../../src/builders/op';
import { defineEntity } from '../../src/defineEntity';
import { defineOperations } from '../../src/defineOperations';
import {
  entityConfigToManifestEntry,
  fieldDefToManifestField,
} from '../../src/manifest/entityConfigToManifest';

describe('entityConfigToManifestEntry', () => {
  it('converts fields, route metadata, and operation overrides into a manifest entry', () => {
    const Note = defineEntity('Note', {
      namespace: 'notes',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        status: field.enum(['draft', 'published'] as const),
        title: field.string(),
      },
      routes: {
        defaults: { auth: 'userAuth' },
        create: {},
        operations: {
          publish: { auth: 'userAuth' },
        },
      },
    });
    const noteOperations = defineOperations(Note, {
      publish: op.custom({
        http: { method: 'post' },
      }),
    });

    const manifestEntry = entityConfigToManifestEntry(Note, {
      operations: noteOperations.operations,
      routePath: 'drafts',
      adapterTransforms: [{ handler: 'notes.note.decorate' }],
      channels: {
        channels: {
          live: {
            auth: 'userAuth',
            forward: { events: ['notes:note.created'], idField: 'id' },
          },
        },
      },
      operationOverrides: {
        publish: {
          kind: 'custom',
          handler: 'notes.note.publish',
          http: { method: 'post' },
        },
      },
    });

    expect(manifestEntry.fields.status).toEqual({
      type: 'enum',
      values: ['draft', 'published'],
    });
    expect(manifestEntry.operations?.publish).toEqual({
      kind: 'custom',
      handler: 'notes.note.publish',
      http: { method: 'post' },
    });
    expect(manifestEntry.routePath).toBe('drafts');
    expect(manifestEntry.adapterTransforms).toEqual([{ handler: 'notes.note.decorate' }]);
    expect(manifestEntry.channels).toEqual({
      channels: {
        live: {
          auth: 'userAuth',
          forward: { events: ['notes:note.created'], idField: 'id' },
        },
      },
    });
    expect(manifestEntry.routes?.defaults?.auth).toBe('userAuth');
  });
});

describe('fieldDefToManifestField', () => {
  it('preserves enum values for manifest conversion', () => {
    expect(
      fieldDefToManifestField(field.enum(['owner', 'member'] as const, { optional: true })),
    ).toEqual({
      type: 'enum',
      optional: true,
      values: ['owner', 'member'],
    });
  });
});
