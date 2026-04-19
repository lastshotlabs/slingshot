import { describe, expect, it } from 'bun:test';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { auditEntity } from '../../packages/slingshot-entity/src/audits';
import {
  createEntityHandlerRegistry,
  parseAndResolveEntityManifest,
  parseAndResolveMultiEntityManifest,
  resolveEntityManifest,
  resolveMultiEntityManifest,
  validateEntityManifest,
} from '../../packages/slingshot-entity/src/manifest';
import { multiEntityManifestSchema } from '../../packages/slingshot-entity/src/manifest/multiEntityManifest';

// ---------------------------------------------------------------------------
// Test manifest (plain JSON)
// ---------------------------------------------------------------------------

const messageManifest = {
  name: 'Message',
  namespace: 'chat',
  fields: {
    id: { type: 'string', primary: true, default: 'uuid' },
    roomId: { type: 'string' },
    authorId: { type: 'string' },
    content: { type: 'string' },
    status: { type: 'enum', values: ['sent', 'delivered', 'read', 'deleted'], default: 'sent' },
    createdAt: { type: 'date', default: 'now' },
  },
  indexes: [{ fields: ['roomId', 'createdAt'], direction: 'desc' }],
  softDelete: { field: 'status', value: 'deleted' },
  pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 50, maxLimit: 200 },
  operations: {
    getByRoom: { kind: 'lookup', fields: { roomId: 'param:roomId' }, returns: 'many' },
    markDelivered: {
      kind: 'transition',
      field: 'status',
      from: 'sent',
      to: 'delivered',
      match: { id: 'param:id' },
    },
    deleteByRoom: {
      kind: 'batch',
      action: 'delete',
      filter: { roomId: 'param:roomId' },
      returns: 'count',
    },
    searchContent: { kind: 'search', fields: ['content'] },
  },
};

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('Entity Manifest Schema', () => {
  it('validates a correct manifest', () => {
    const result = validateEntityManifest(messageManifest);
    expect(result.success).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.name).toBe('Message');
  });

  it('rejects manifest without name', () => {
    const result = validateEntityManifest({ fields: { id: { type: 'string', primary: true } } });
    expect(result.success).toBe(false);
  });

  it('rejects manifest with invalid field type', () => {
    const result = validateEntityManifest({
      name: 'Bad',
      fields: { id: { type: 'invalid_type', primary: true } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects manifest with invalid operation kind', () => {
    const result = validateEntityManifest({
      name: 'Bad',
      fields: { id: { type: 'string', primary: true } },
      operations: { bad: { kind: 'nonexistent' } },
    });
    expect(result.success).toBe(false);
  });

  it('validates all 15 operation kinds', () => {
    const manifest = {
      name: 'Test',
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        name: { type: 'string' },
        status: { type: 'enum', values: ['a', 'b'] },
        score: { type: 'integer' },
      },
      operations: {
        op1: { kind: 'lookup', fields: { name: 'param:name' }, returns: 'one' },
        op2: { kind: 'exists', fields: { id: 'param:id' } },
        op3: { kind: 'transition', field: 'status', from: 'a', to: 'b', match: { id: 'param:id' } },
        op4: { kind: 'fieldUpdate', match: { id: 'param:id' }, set: ['name'] },
        op5: { kind: 'aggregate', compute: { count: 'count' } },
        op6: { kind: 'batch', action: 'delete', filter: { name: 'param:name' } },
        op7: { kind: 'upsert', match: ['name'], set: ['score'] },
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
    };
    const result = validateEntityManifest(manifest);
    expect(result.success).toBe(true);
  });

  describe('filter expressions with logical operators', () => {
    it('validates $and filter', () => {
      const result = validateEntityManifest({
        name: 'Test',
        fields: { id: { type: 'string', primary: true } },
        operations: {
          op1: {
            kind: 'batch',
            action: 'delete',
            filter: { $and: [{ roomId: 'param:roomId' }, { status: { $ne: 'deleted' } }] },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('validates $or filter', () => {
      const result = validateEntityManifest({
        name: 'Test',
        fields: { id: { type: 'string', primary: true } },
        operations: {
          op1: {
            kind: 'batch',
            action: 'delete',
            filter: { $or: [{ type: 'a' }, { type: 'b' }] },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('validates mixed field conditions + $or', () => {
      const result = validateEntityManifest({
        name: 'Test',
        fields: { id: { type: 'string', primary: true } },
        operations: {
          op1: {
            kind: 'batch',
            action: 'update',
            filter: { status: 'active', $or: [{ role: 'admin' }, { role: 'mod' }] },
            set: { status: 'processed' },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('validates nested $and inside $or', () => {
      const result = validateEntityManifest({
        name: 'Test',
        fields: { id: { type: 'string', primary: true } },
        operations: {
          op1: {
            kind: 'batch',
            action: 'delete',
            filter: {
              $or: [{ $and: [{ status: 'draft' }, { age: { $gt: 30 } }] }, { status: 'expired' }],
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('Entity Manifest Resolution', () => {
  it('resolves manifest to ResolvedEntityConfig', () => {
    const { config } = resolveEntityManifest(messageManifest as any);
    expect(config.name).toBe('Message');
    expect(config.namespace).toBe('chat');
    expect(config._pkField).toBe('id');
    expect(config._storageName).toBe('chat_messages');
    expect(config.fields.id.primary).toBe(true);
    expect(config.fields.status.enumValues).toEqual(['sent', 'delivered', 'read', 'deleted']);
  });

  it('resolves operations', () => {
    const { operations } = resolveEntityManifest(messageManifest as any);
    expect(Object.keys(operations)).toEqual([
      'getByRoom',
      'markDelivered',
      'deleteByRoom',
      'searchContent',
    ]);
    expect(operations.getByRoom.kind).toBe('lookup');
    expect(operations.markDelivered.kind).toBe('transition');
  });

  it('derives _storageName without namespace', () => {
    const { config } = resolveEntityManifest({
      name: 'User',
      fields: { id: { type: 'string', primary: true } },
    } as any);
    expect(config._storageName).toBe('users');
  });

  it('throws on missing primary key', () => {
    expect(() =>
      resolveEntityManifest({ name: 'Bad', fields: { name: { type: 'string' } } } as any),
    ).toThrow('No primary key');
  });

  it('resolves custom ops with handler registry', () => {
    const registry = createEntityHandlerRegistry();
    registry.register(
      'my-scorer',
      () => () => (record: Record<string, unknown>) => (record.score as number) * 2,
    );

    const manifest = {
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { score: { kind: 'custom', handler: 'my-scorer' } },
    };
    const { operations } = resolveEntityManifest(manifest as any, registry);
    expect(operations.score.kind).toBe('custom');
  });

  it('throws on custom op without registry', () => {
    const manifest = {
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { score: { kind: 'custom', handler: 'my-scorer' } },
    };
    expect(() => resolveEntityManifest(manifest as any)).toThrow('requires a handler registry');
  });
});

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

describe('Entity Handler Registry', () => {
  it('registers and resolves handlers', () => {
    const registry = createEntityHandlerRegistry();
    // HandlerFactory: (params?) => (backendDriver) => handler
    registry.register('double', () => () => (x: number) => x * 2);
    const backendFactory = registry.resolve('double') as (driver: unknown) => (x: number) => number;
    const handler = backendFactory(null);
    expect(handler(5)).toBe(10);
  });

  it('throws on unknown handler', () => {
    const registry = createEntityHandlerRegistry();
    expect(() => registry.resolve('nonexistent')).toThrow('Unknown handler');
  });

  it('supports parent/child composition', () => {
    const parent = createEntityHandlerRegistry();
    parent.register('base-fn', () => () => 'from-parent');
    const child = parent.extend();
    child.register('child-fn', () => () => 'from-child');

    const baseFn = child.resolve('base-fn') as (d: unknown) => string;
    const childFn = child.resolve('child-fn') as (d: unknown) => string;
    expect(baseFn(null)).toBe('from-parent');
    expect(childFn(null)).toBe('from-child');
    expect(child.has('base-fn')).toBe(true);
    expect(parent.has('child-fn')).toBe(false);
  });

  it('lists all handlers including parent', () => {
    const parent = createEntityHandlerRegistry();
    parent.register('a', () => () => {});
    const child = parent.extend();
    child.register('b', () => () => {});
    expect(child.list()).toContain('a');
    expect(child.list()).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// Multi-entity manifest
// ---------------------------------------------------------------------------

describe('Multi-Entity Manifest', () => {
  it('resolves multiple entities', () => {
    const manifest = {
      manifestVersion: 1,
      namespace: 'chat',
      entities: {
        message: messageManifest,
        room: {
          name: 'Room',
          fields: {
            id: { type: 'string', primary: true, default: 'uuid' },
            name: { type: 'string' },
          },
        },
      },
    };
    const result = parseAndResolveMultiEntityManifest(manifest);
    expect(Object.keys(result.entities)).toEqual(['message', 'room']);
    expect(result.entities.message.config.name).toBe('Message');
    expect(result.entities.room.config.name).toBe('Room');
    expect(result.entities.room.config.namespace).toBe('chat'); // inherited
  });

  it('entity namespace overrides top-level', () => {
    const manifest = {
      manifestVersion: 1,
      namespace: 'default',
      entities: {
        item: {
          name: 'Item',
          namespace: 'custom',
          fields: { id: { type: 'string', primary: true } },
        },
      },
    };
    const result = parseAndResolveMultiEntityManifest(manifest);
    expect(result.entities.item.config.namespace).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// Integration: manifest → adapter → operations
// ---------------------------------------------------------------------------

describe('Manifest → Runtime Integration', () => {
  it('creates working adapter from JSON manifest', async () => {
    const { config, operations } = parseAndResolveEntityManifest(messageManifest);
    const factories = createEntityFactories(config, operations);
    const adapter = factories.memory();

    // CRUD works
    const m1 = await adapter.create({ roomId: 'r1', authorId: 'u1', content: 'hello' });
    expect(m1.id).toBeDefined();

    // Operations work
    const byRoom = await (adapter as Record<string, (...args: unknown[]) => unknown>).getByRoom({ roomId: 'r1' });
    expect(byRoom.items.length).toBe(1);

    const delivered = await (adapter as Record<string, (...args: unknown[]) => unknown>).markDelivered({ id: m1.id });
    expect(delivered.status).toBe('delivered');

    const searchResults = await (adapter as Record<string, (...args: unknown[]) => unknown>).searchContent('hello');
    expect(searchResults.length).toBe(1);
  });

  it('audits work on manifest-resolved configs', () => {
    const { config, operations } = parseAndResolveEntityManifest(messageManifest);
    const result = auditEntity(config, operations);
    expect(result.entity).toBe('Message');
    expect(result.errors).toBe(0);
  });

  it('custom ops execute on runtime adapter', async () => {
    const registry = createEntityHandlerRegistry();
    // HandlerFactory: (params?) => (backendDriver) => handler
    registry.register(
      'double-score',
      () => () => async (record: Record<string, unknown>) => ({
        ...record,
        score: (record.score as number) * 2,
      }),
    );

    const manifest = {
      name: 'Item',
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        score: { type: 'integer', default: 0 },
      },
      operations: {
        doubleScore: { kind: 'custom', handler: 'double-score' },
      },
    };

    const { config, operations } = parseAndResolveEntityManifest(manifest, registry);
    const adapter = createEntityFactories(config, operations).memory();
    const item = await adapter.create({ score: 5 });

    const fn = (adapter as Record<string, (...args: unknown[]) => unknown>).doubleScore;
    expect(typeof fn).toBe('function');
    const result = await fn(item);
    expect(result.score).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Negative parity tests — manifest rejects what builders reject
// ---------------------------------------------------------------------------

describe('Manifest/Builder Parity — Rejections', () => {
  it('rejects entity with no primary key', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { name: { type: 'string' } },
      }),
    ).toThrow('No primary key');
  });

  it('rejects entity with multiple primary keys', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: {
          id: { type: 'string', primary: true },
          otherId: { type: 'string', primary: true },
        },
      }),
    ).toThrow('Multiple primary key');
  });

  it('rejects primary key with invalid type', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'boolean', primary: true } },
      }),
    ).toThrow('must be string, number, or integer');
  });

  it('rejects softDelete referencing nonexistent field', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'string', primary: true } },
        softDelete: { field: 'nonexistent', value: 'deleted' },
      }),
    ).toThrow("softDelete.field 'nonexistent' not found");
  });

  it('rejects tenant referencing nonexistent field', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'string', primary: true } },
        tenant: { field: 'nonexistent' },
      }),
    ).toThrow("tenant.field 'nonexistent' not found");
  });

  it('rejects index referencing unknown field', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'string', primary: true } },
        indexes: [{ fields: ['nonexistent'] }],
      }),
    ).toThrow("Index references unknown field 'nonexistent'");
  });

  it('rejects pagination cursor referencing unknown field', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'string', primary: true } },
        pagination: { cursor: { fields: ['nonexistent'] } },
      }),
    ).toThrow("pagination.cursor references unknown field 'nonexistent'");
  });

  it('rejects operation referencing unknown field (via defineOperations)', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'string', primary: true } },
        operations: {
          bad: { kind: 'search', fields: ['nonexistent'] },
        },
      }),
    ).toThrow("references unknown field 'nonexistent'");
  });

  it('rejects custom op with unknown handler', () => {
    const registry = createEntityHandlerRegistry();
    expect(() =>
      parseAndResolveEntityManifest(
        {
          name: 'Bad',
          fields: { id: { type: 'string', primary: true } },
          operations: { bad: { kind: 'custom', handler: 'nonexistent' } },
        },
        registry,
      ),
    ).toThrow('unknown handler');
  });

  it('rejects custom op without registry', () => {
    expect(() =>
      parseAndResolveEntityManifest({
        name: 'Bad',
        fields: { id: { type: 'string', primary: true } },
        operations: { bad: { kind: 'custom', handler: 'anything' } },
      }),
    ).toThrow('requires a handler registry');
  });
});

// ---------------------------------------------------------------------------
// customOpSchema — http field (Phase 1)
// ---------------------------------------------------------------------------

describe('customOpSchema — http field', () => {
  it('accepts routing-only custom op (no handler, http present)', () => {
    const result = validateEntityManifest({
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { publish: { kind: 'custom', http: { method: 'post' } } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts routing-only custom op with explicit path override', () => {
    const result = validateEntityManifest({
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { publish: { kind: 'custom', http: { method: 'post', path: 'send' } } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom op with handler only (existing path unchanged)', () => {
    const registry = createEntityHandlerRegistry();
    registry.register('sendEmail', { memory: () => async () => ({}) } as never);
    const result = validateEntityManifest({
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { notify: { kind: 'custom', handler: 'sendEmail' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom op with both handler and http', () => {
    const result = validateEntityManifest({
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: {
        publish: { kind: 'custom', handler: 'myHandler', http: { method: 'post' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects custom op with neither handler nor http', () => {
    const result = validateEntityManifest({
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { bad: { kind: 'custom' } },
    });
    expect(result.success).toBe(false);
    expect(result.errors?.message).toContain("'handler'");
  });

  it('resolves to op.custom({ http }) when handler is absent', () => {
    const { config, operations } = parseAndResolveEntityManifest({
      name: 'Item',
      fields: { id: { type: 'string', primary: true } },
      operations: { publish: { kind: 'custom', http: { method: 'post' } } },
    });
    expect(config.name).toBe('Item');
    expect(operations.publish).toEqual({ kind: 'custom', http: { method: 'post' } });
  });
});

// ---------------------------------------------------------------------------
// multiEntityManifestSchema — composites (Phase 2)
// ---------------------------------------------------------------------------

const twoEntityManifest = {
  manifestVersion: 1,
  entities: {
    Document: {
      fields: {
        id: { type: 'string' as const, primary: true, default: 'uuid' },
        title: { type: 'string' as const },
      },
    },
    Snapshot: {
      fields: {
        id: { type: 'string' as const, primary: true, default: 'uuid' },
        documentId: { type: 'string' as const },
        title: { type: 'string' as const },
      },
    },
  },
};

describe('multiEntityManifestSchema — composites', () => {
  it('validates a manifest with a valid composite entry', () => {
    const result = parseAndResolveMultiEntityManifest({
      ...twoEntityManifest,
      composites: {
        docSnapshot: {
          entities: ['Document', 'Snapshot'],
          entityKey: 'Document',
          operations: {
            revert: {
              kind: 'transaction',
              steps: [
                { op: 'lookup', entity: 'Snapshot', match: { id: 'param:versionId' } },
                {
                  op: 'fieldUpdate',
                  entity: 'Document',
                  match: { id: 'param:id' },
                  set: { title: 'result:0.title' },
                },
              ],
            },
          },
        },
      },
    });
    expect(result.composites['docSnapshot']).toBeDefined();
    expect(result.composites['docSnapshot'].entityKey).toBe('Document');
    expect(result.composites['docSnapshot'].entities).toEqual(['Document', 'Snapshot']);
    expect(result.composites['docSnapshot'].operations['revert'].kind).toBe('transaction');
  });

  it('rejects a composite referencing an unknown entity', () => {
    const result = multiEntityManifestSchema.safeParse({
      ...twoEntityManifest,
      composites: {
        bad: { entities: ['Document', 'NonExistent'], entityKey: 'Document' },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('NonExistent');
  });

  it('rejects a composite with entityKey not in entities list', () => {
    const result = multiEntityManifestSchema.safeParse({
      ...twoEntityManifest,
      composites: {
        bad: { entities: ['Document', 'Snapshot'], entityKey: 'WrongKey' },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('WrongKey');
  });

  it('resolveMultiEntityManifest returns composites in result', () => {
    const result = resolveMultiEntityManifest({
      ...twoEntityManifest,
      composites: {
        docSnapshot: {
          entities: ['Document', 'Snapshot'],
          entityKey: 'Document',
        },
      },
    });
    expect(Object.keys(result.composites)).toHaveLength(1);
    expect(result.composites['docSnapshot'].entityKey).toBe('Document');
    expect(result.composites['docSnapshot'].entities).toEqual(['Document', 'Snapshot']);
  });

  it('composites without operations resolves to empty operations map', () => {
    const result = resolveMultiEntityManifest({
      ...twoEntityManifest,
      composites: {
        docSnapshot: { entities: ['Document', 'Snapshot'], entityKey: 'Snapshot' },
      },
    });
    expect(result.composites['docSnapshot'].operations).toEqual({});
  });

  it('resolveMultiEntityManifest returns empty composites when none declared', () => {
    const result = resolveMultiEntityManifest(twoEntityManifest);
    expect(result.composites).toEqual({});
  });
});
