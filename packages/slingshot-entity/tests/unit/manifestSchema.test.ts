/**
 * manifestEntitySchema / manifestEntitiesSchema — Zod validation tests.
 *
 * Verifies correct JSON entity definitions pass and invalid ones fail with
 * clear errors.
 */
import { describe, expect, it } from 'bun:test';
import type { ManifestEntities, ManifestEntity } from '../../src/index';
import {
  activityLogConfigSchema,
  autoGrantConfigSchema,
  manifestEntitiesSchema,
  manifestEntitySchema,
  multiEntityManifestSchema,
  runtimeHookRefSchema,
} from '../../src/index';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const validEntityDef: ManifestEntity = {
  namespace: 'shop',
  fields: {
    id: { type: 'string', primary: true, default: 'uuid' },
    name: { type: 'string' },
    status: { type: 'enum', values: ['active', 'inactive'], default: 'active' },
    createdAt: { type: 'date', default: 'now' },
  },
  indexes: [{ fields: ['name'] }],
  operations: {
    byName: { kind: 'lookup', fields: { name: 'param:name' }, returns: 'one' },
  },
};

// ---------------------------------------------------------------------------
// manifestEntitySchema — single entity
// ---------------------------------------------------------------------------

describe('manifestEntitySchema', () => {
  it('validates a well-formed entity definition', () => {
    const result = manifestEntitySchema.safeParse(validEntityDef);
    expect(result.success).toBe(true);
  });

  it('accepts entity without namespace', () => {
    const result = manifestEntitySchema.safeParse({
      fields: { id: { type: 'string', primary: true } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all supported field types', () => {
    const result = manifestEntitySchema.safeParse({
      fields: {
        id: { type: 'string', primary: true },
        a: { type: 'string' },
        a1: { type: 'string', format: 'email' },
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
        status: { type: 'enum', values: ['on', 'off'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts field with optional, immutable, default, and onUpdate', () => {
    const result = manifestEntitySchema.safeParse({
      fields: {
        id: { type: 'string', primary: true, default: 'uuid', immutable: true },
        label: { type: 'string', optional: true },
        month: { type: 'string', format: 'month' },
        updatedAt: { type: 'date', onUpdate: 'now' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts entity adapterTransforms hook refs', () => {
    const result = manifestEntitySchema.safeParse({
      ...validEntityDef,
      adapterTransforms: [
        { handler: 'note.first' },
        { handler: 'note.second', params: { key: 'value' } },
      ],
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
            {
              op: 'arrayPush',
              entity: 'Test',
              match: { id: 'param:id' },
              field: 'tags',
              value: 'param:tag',
            },
            {
              op: 'arrayPull',
              entity: 'Test',
              match: { id: 'param:id' },
              field: 'tags',
              value: 'param:tag',
            },
            { op: 'lookup', entity: 'Test', match: { id: 'param:id' } },
            { op: 'increment', entity: 'Test', match: { id: 'param:id' }, field: 'count', by: 2 },
          ],
        },
        op15: {
          kind: 'pipe',
          steps: [
            { op: 'search', config: { fields: ['name'] } },
            { op: 'aggregate', config: { compute: { count: 'count' } } },
          ],
        },
        op16: { kind: 'arrayPush', field: 'tags', value: 'param:tag' },
        op17: { kind: 'arrayPull', field: 'tags', value: 'param:tag' },
        op18: { kind: 'arraySet', field: 'tags', value: 'param:tags', dedupe: true },
        op19: { kind: 'increment', field: 'count', by: 5 },
      },
    });
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
});

// ---------------------------------------------------------------------------
// manifestEntitiesSchema — record of entities
// ---------------------------------------------------------------------------

describe('manifestEntitiesSchema', () => {
  it('validates a record of entity definitions', () => {
    const entities: ManifestEntities = { Product: validEntityDef };
    const result = manifestEntitiesSchema.safeParse(entities);
    expect(result.success).toBe(true);
  });

  it('validates multiple entities', () => {
    const result = manifestEntitiesSchema.safeParse({
      Product: validEntityDef,
      User: {
        fields: {
          id: { type: 'string', primary: true, default: 'uuid' },
          email: { type: 'string' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when any entity has an invalid field type', () => {
    const result = manifestEntitiesSchema.safeParse({
      Product: validEntityDef,
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
// autoGrantConfigSchema
// ---------------------------------------------------------------------------

describe('autoGrantConfigSchema', () => {
  it('validates a well-formed autoGrant config', () => {
    const result = autoGrantConfigSchema.safeParse({
      on: 'created',
      role: 'document:owner',
      subjectField: 'createdBy',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown "on" value', () => {
    const result = autoGrantConfigSchema.safeParse({
      on: 'updated',
      role: 'document:owner',
      subjectField: 'createdBy',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty role', () => {
    const result = autoGrantConfigSchema.safeParse({
      on: 'created',
      role: '',
      subjectField: 'createdBy',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty subjectField', () => {
    const result = autoGrantConfigSchema.safeParse({
      on: 'created',
      role: 'owner',
      subjectField: '',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// activityLogConfigSchema
// ---------------------------------------------------------------------------

describe('activityLogConfigSchema', () => {
  it('validates a well-formed activityLog config', () => {
    const result = activityLogConfigSchema.safeParse({
      entity: 'Activity',
      resourceType: 'content:document',
      events: {
        created: { action: 'created', meta: ['title', 'typeId'] },
        deleted: { action: 'deleted' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty entity string', () => {
    const result = activityLogConfigSchema.safeParse({
      entity: '',
      resourceType: 'doc',
      events: { created: { action: 'created' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty resourceType string', () => {
    const result = activityLogConfigSchema.safeParse({
      entity: 'Activity',
      resourceType: '',
      events: { created: { action: 'created' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects event with empty action', () => {
    const result = activityLogConfigSchema.safeParse({
      entity: 'Activity',
      resourceType: 'doc',
      events: { created: { action: '' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts events without meta field', () => {
    const result = activityLogConfigSchema.safeParse({
      entity: 'Activity',
      resourceType: 'doc',
      events: { deleted: { action: 'deleted' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events['deleted'].meta).toBeUndefined();
    }
  });
});

describe('runtimeHookRefSchema', () => {
  it('accepts hook refs with optional params', () => {
    const result = runtimeHookRefSchema.safeParse({
      handler: 'community.captureAdapters',
      params: { mode: 'strict' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects hook refs without a handler', () => {
    const result = runtimeHookRefSchema.safeParse({
      params: { mode: 'strict' },
    });
    expect(result.success).toBe(false);
  });
});

describe('multiEntityManifestSchema runtime hooks', () => {
  it('accepts root-level hooks.afterAdapters refs', () => {
    const result = multiEntityManifestSchema.safeParse({
      manifestVersion: 1,
      hooks: {
        afterAdapters: [{ handler: 'community.captureAdapters' }],
      },
      entities: {
        Note: validEntityDef,
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// entityManifestSchema with autoGrant + activityLog
// ---------------------------------------------------------------------------

describe('entityManifestSchema — autoGrant and activityLog fields', () => {
  it('accepts entity with autoGrant', () => {
    const result = manifestEntitySchema.safeParse({
      ...validEntityDef,
      autoGrant: { on: 'created', role: 'owner', subjectField: 'createdBy' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts entity with activityLog', () => {
    const result = manifestEntitySchema.safeParse({
      ...validEntityDef,
      activityLog: {
        entity: 'Activity',
        resourceType: 'shop:product',
        events: { created: { action: 'created', meta: ['name'] } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts entity with both autoGrant and activityLog', () => {
    const result = manifestEntitySchema.safeParse({
      ...validEntityDef,
      autoGrant: { on: 'created', role: 'owner', subjectField: 'createdBy' },
      activityLog: {
        entity: 'Activity',
        resourceType: 'shop:product',
        events: { created: { action: 'created' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid autoGrant nested inside entity', () => {
    const result = manifestEntitySchema.safeParse({
      ...validEntityDef,
      autoGrant: { on: 'deleted', role: 'owner', subjectField: 'createdBy' },
    });
    expect(result.success).toBe(false);
  });
});
