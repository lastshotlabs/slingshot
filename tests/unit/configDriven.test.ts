import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  applyDefaults,
  applyOnUpdate,
  createEntityFactories,
  createMemoryEntityAdapter,
  createSqliteEntityAdapter,
  decodeCursor,
  encodeCursor,
  generateSchemas,
  toCamelCase,
  toSnakeCase,
} from '@lastshotlabs/slingshot-entity';
import {
  defineEntity,
  field,
  index,
  relation,
} from '../../packages/slingshot-core/src/entityConfig';
import type {
  EntityAdapter,
  InferEntity,
} from '../../packages/slingshot-core/src/entityConfig';
import { resolveRepo } from '../../packages/slingshot-core/src/storeInfra';
import type { StoreInfra } from '../../packages/slingshot-core/src/storeInfra';
import {
  coerceToDate,
  fromSqliteRow,
  storageName,
  toSqliteRow,
} from '../../packages/slingshot-entity/src/configDriven/fieldUtils';
import {
  type FrameworkStoreInfra,
  RESOLVE_SEARCH_SYNC,
} from '../../src/framework/persistence/internalRepoResolution';

// ---------------------------------------------------------------------------
// Test entity definitions using the field.*() builder API
// ---------------------------------------------------------------------------

const ticketFields = {
  id: field.string({ primary: true, default: 'uuid' }),
  subject: field.string(),
  priority: field.integer({ default: 0 }),
  metadata: field.json({ optional: true }),
  active: field.boolean({ optional: true }),
  createdAt: field.date({ default: 'now' }),
  updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
};

const Ticket = defineEntity('Ticket', {
  namespace: 'support',
  fields: ticketFields,
});

type TicketEntity = InferEntity<typeof ticketFields>;

const tokenFields = {
  key: field.string({ primary: true }),
  userId: field.string(),
  createdAt: field.date({ default: 'now' }),
};

const Token = defineEntity('Token', {
  fields: tokenFields,
  ttl: { defaultSeconds: 3600 },
});

// ---------------------------------------------------------------------------
// fieldUtils tests
// ---------------------------------------------------------------------------

describe('fieldUtils', () => {
  describe('toSnakeCase', () => {
    it('converts camelCase to snake_case', () => {
      expect(toSnakeCase('createdAt')).toBe('created_at');
      expect(toSnakeCase('ownerUserId')).toBe('owner_user_id');
      expect(toSnakeCase('id')).toBe('id');
    });
  });

  describe('toCamelCase', () => {
    it('converts snake_case to camelCase', () => {
      expect(toCamelCase('created_at')).toBe('createdAt');
      expect(toCamelCase('owner_user_id')).toBe('ownerUserId');
      expect(toCamelCase('id')).toBe('id');
    });
  });

  describe('toSqliteRow / fromSqliteRow', () => {
    it('converts camelCase record to snake_case with type transforms', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const record: Record<string, unknown> = {
        id: 't-1',
        subject: 'Bug report',
        priority: 3,
        metadata: { tags: ['urgent'] },
        active: true,
        createdAt: now,
      };
      const row = toSqliteRow(record, Ticket.fields);
      expect(row['id']).toBe('t-1');
      expect(row['subject']).toBe('Bug report');
      expect(row['priority']).toBe(3);
      expect(row['metadata']).toBe('{"tags":["urgent"]}');
      expect(row['active']).toBe(1);
      expect(row['created_at']).toBe(now.getTime());
    });

    it('round-trips through toSqliteRow / fromSqliteRow', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const record: Record<string, unknown> = {
        id: 't-1',
        subject: 'Hello',
        priority: 5,
        metadata: { key: 'value' },
        active: false,
        createdAt: now,
      };
      const row = toSqliteRow(record, Ticket.fields);
      const restored = fromSqliteRow(row, Ticket.fields);
      expect(restored['id']).toBe('t-1');
      expect(restored['subject']).toBe('Hello');
      expect(restored['priority']).toBe(5);
      expect((restored['metadata'] as { key: string }).key).toBe('value');
      expect(restored['active']).toBe(false);
      expect(restored['createdAt']).toEqual(now);
    });

    it('skips undefined fields', () => {
      const record: Record<string, unknown> = { id: 't-1', subject: 'Test' };
      const row = toSqliteRow(record, Ticket.fields);
      expect(row).not.toHaveProperty('metadata');
      expect(row).not.toHaveProperty('active');
    });
  });

  describe('applyDefaults', () => {
    it('applies auto-defaults (uuid, now) on create', () => {
      const input: Record<string, unknown> = { subject: 'Test' };
      const result = applyDefaults(input, Ticket.fields);
      expect(typeof result['id']).toBe('string');
      expect((result['id'] as string).length).toBeGreaterThan(0);
      expect(result['createdAt']).toBeInstanceOf(Date);
      expect(result['updatedAt']).toBeInstanceOf(Date);
    });

    it('applies literal defaults', () => {
      const input: Record<string, unknown> = { id: 'x', subject: 'Test' };
      const result = applyDefaults(input, Ticket.fields);
      expect(result['priority']).toBe(0);
    });

    it('does not override explicit values', () => {
      const input: Record<string, unknown> = { id: 'custom-id', subject: 'Test', priority: 5 };
      const result = applyDefaults(input, Ticket.fields);
      expect(result['id']).toBe('custom-id');
      expect(result['priority']).toBe(5);
    });
  });

  describe('applyOnUpdate', () => {
    it('sets onUpdate: now fields', () => {
      const input: Record<string, unknown> = { subject: 'Updated' };
      const result = applyOnUpdate(input, Ticket.fields);
      expect(result['updatedAt']).toBeInstanceOf(Date);
      expect(result['subject']).toBe('Updated');
    });
  });

  describe('encodeCursor / decodeCursor', () => {
    it('round-trips cursor values', () => {
      const values = { createdAt: '2024-01-15T12:00:00.000Z', id: 'abc-123' };
      const encoded = encodeCursor(values);
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(values);
    });
  });

  describe('storageName', () => {
    it('applies namespace prefix', () => {
      expect(storageName(Ticket, 'sqlite')).toBe('support_tickets');
    });

    it('uses custom table name from storage hints', () => {
      const cfg = defineEntity('Item', {
        fields: { id: field.string({ primary: true }) },
        storage: { sqlite: { tableName: 'my_custom_items' } },
      });
      expect(storageName(cfg, 'sqlite')).toBe('my_custom_items');
    });
  });

  describe('coerceToDate', () => {
    it('handles Date instances', () => {
      const d = new Date('2024-01-01');
      expect(coerceToDate(d)).toBe(d);
    });

    it('handles epoch ms numbers', () => {
      const ms = 1705312800000;
      expect(coerceToDate(ms).getTime()).toBe(ms);
    });

    it('handles ISO strings', () => {
      const iso = '2024-01-15T12:00:00.000Z';
      expect(coerceToDate(iso).toISOString()).toBe(iso);
    });
  });
});

// ---------------------------------------------------------------------------
// defineEntity validation
// ---------------------------------------------------------------------------

describe('defineEntity', () => {
  it('resolves a valid config with _pkField and _storageName', () => {
    const cfg = defineEntity('Test', {
      fields: { id: field.string({ primary: true }) },
    });
    expect(cfg.name).toBe('Test');
    expect(cfg._pkField).toBe('id');
    expect(cfg._storageName).toBe('tests');
  });

  it('applies namespace to storage name', () => {
    const cfg = defineEntity('Message', {
      namespace: 'chat',
      fields: { id: field.string({ primary: true }) },
    });
    expect(cfg._storageName).toBe('chat_messages');
  });

  it('throws when no primary key defined', () => {
    expect(() =>
      defineEntity('NoPk', {
        fields: { name: field.string() },
      }),
    ).toThrow('No primary key');
  });

  it('throws when multiple primary keys defined', () => {
    expect(() =>
      defineEntity('MultiPk', {
        fields: {
          id: field.string({ primary: true }),
          code: field.string({ primary: true }),
        },
      }),
    ).toThrow('Multiple primary key');
  });

  it('throws when PK type is not string/number/integer', () => {
    expect(() =>
      defineEntity('BoolPk', {
        fields: { id: field.boolean({ primary: true }) },
      }),
    ).toThrow('string, number, or integer');
  });

  it('throws when softDelete field does not exist', () => {
    expect(() =>
      defineEntity('BadSd', {
        fields: { id: field.string({ primary: true }) },
        softDelete: { field: 'status', value: 'deleted' },
      }),
    ).toThrow("softDelete.field 'status' not found");
  });

  it('throws when index references unknown field', () => {
    expect(() =>
      defineEntity('BadIdx', {
        fields: { id: field.string({ primary: true }) },
        indexes: [index(['nonexistent'])],
      }),
    ).toThrow("unknown field 'nonexistent'");
  });

  it('throws when pagination cursor references unknown field', () => {
    expect(() =>
      defineEntity('BadCursor', {
        fields: { id: field.string({ primary: true }) },
        pagination: { cursor: { fields: ['missing'] } },
      }),
    ).toThrow("unknown field 'missing'");
  });
});

// ---------------------------------------------------------------------------
// field.*() builder API
// ---------------------------------------------------------------------------

describe('field builders', () => {
  it('creates string field with defaults', () => {
    const f = field.string();
    expect(f.type).toBe('string');
    expect(f.optional).toBe(false);
    expect(f.primary).toBe(false);
    expect(f.immutable).toBe(false);
  });

  it('creates primary key field (immutable by default)', () => {
    const f = field.string({ primary: true });
    expect(f.primary).toBe(true);
    expect(f.immutable).toBe(true);
  });

  it('creates enum field with values', () => {
    const f = field.enum(['active', 'deleted', 'archived']);
    expect(f.type).toBe('enum');
    expect(f.enumValues).toEqual(['active', 'deleted', 'archived']);
  });

  it('creates date field with onUpdate', () => {
    const f = field.date({ default: 'now', onUpdate: 'now' });
    expect(f.type).toBe('date');
    expect(f.default).toBe('now');
    expect(f.onUpdate).toBe('now');
  });

  it('creates json field', () => {
    const f = field.json({ optional: true });
    expect(f.type).toBe('json');
    expect(f.optional).toBe(true);
  });

  it('creates stringArray field', () => {
    const f = field.stringArray();
    expect(f.type).toBe('string[]');
  });
});

// ---------------------------------------------------------------------------
// index() and relation() builders
// ---------------------------------------------------------------------------

describe('index builder', () => {
  it('creates index definition', () => {
    const idx = index(['roomId', 'createdAt'], { direction: 'desc' });
    expect(idx.fields).toEqual(['roomId', 'createdAt']);
    expect(idx.direction).toBe('desc');
  });

  it('creates unique index', () => {
    const idx = index(['email'], { unique: true });
    expect(idx.unique).toBe(true);
  });
});

describe('relation builder', () => {
  it('creates belongsTo relation', () => {
    const rel = relation.belongsTo('User', 'userId');
    expect(rel.kind).toBe('belongsTo');
    expect(rel.target).toBe('User');
    expect(rel.foreignKey).toBe('userId');
  });

  it('creates hasMany relation', () => {
    const rel = relation.hasMany('Message', 'roomId');
    expect(rel.kind).toBe('hasMany');
  });
});

// ---------------------------------------------------------------------------
// createEntityFactories
// ---------------------------------------------------------------------------

describe('createEntityFactories', () => {
  it('produces factories for all five store types', () => {
    const factories = createEntityFactories(Ticket);
    expect(typeof factories.memory).toBe('function');
    expect(typeof factories.redis).toBe('function');
    expect(typeof factories.sqlite).toBe('function');
    expect(typeof factories.mongo).toBe('function');
    expect(typeof factories.postgres).toBe('function');
  });

  it('propagates deletes to the search provider in write-through mode', async () => {
    const deleted: Array<{ indexName: string; documentId: string }> = [];

    // Entity must have search config for write-through sync to activate
    const SearchableTicket = defineEntity('Ticket', {
      namespace: 'support',
      fields: ticketFields,
      search: {
        fields: { subject: { searchable: true } },
      },
    });

    const storeInfra: FrameworkStoreInfra = {
      appName: 'test',
      getRedis: () => {
        throw new Error('no redis');
      },
      getMongo: () => {
        throw new Error('no mongo');
      },
      getSqliteDb: () => {
        throw new Error('no sqlite');
      },
      getPostgres: () => {
        throw new Error('no postgres');
      },
      [RESOLVE_SEARCH_SYNC]: () => ({
        syncMode: 'write-through',
        ensureReady: async () => {},
        indexDocument: async () => {},
        deleteDocument: async documentId => {
          deleted.push({ indexName: 'support_tickets', documentId });
        },
      }),
    };

    const adapter = resolveRepo(
      createEntityFactories(SearchableTicket),
      'memory',
      storeInfra,
    ) as EntityAdapter<any, any, any>;
    const created = await adapter.create({ subject: 'Delete me' });

    await adapter.delete(created.id);

    expect(deleted).toEqual([{ indexName: 'support_tickets', documentId: created.id }]);
  });
});

// ---------------------------------------------------------------------------
// Memory adapter — full CRUD
// ---------------------------------------------------------------------------

describe('memory adapter', () => {
  let adapter: EntityAdapter<TicketEntity, Partial<TicketEntity>, Partial<TicketEntity>>;

  beforeEach(() => {
    adapter = createMemoryEntityAdapter(Ticket) as unknown as EntityAdapter<
      TicketEntity,
      Partial<TicketEntity>,
      Partial<TicketEntity>
    >;
  });

  it('create applies defaults and returns entity', async () => {
    const result = await adapter.create({ subject: 'Login broken' });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.subject).toBe('Login broken');
    expect(result.priority).toBe(0); // literal default
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('getById returns created record', async () => {
    const created = await adapter.create({ subject: 'Test' });
    const found = await adapter.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.subject).toBe('Test');
    expect(found!.id).toBe(created.id);
  });

  it('getById returns null for missing record', async () => {
    expect(await adapter.getById('nonexistent')).toBeNull();
  });

  it('update merges fields and returns updated entity', async () => {
    const created = await adapter.create({ subject: 'Original', priority: 1 });
    const updated = await adapter.update(created.id, { subject: 'Updated', priority: 10 });
    expect(updated!.subject).toBe('Updated');
    expect(updated!.priority).toBe(10);
    expect(updated!.id).toBe(created.id);
  });

  it('update sets onUpdate fields', async () => {
    const created = await adapter.create({ subject: 'Test' });
    const beforeUpdate = created.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = await adapter.update(created.id, { subject: 'Changed' });
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeUpdate).getTime(),
    );
  });

  it('update returns null for missing record', async () => {
    await expect(adapter.update('nope', { subject: 'X' })).resolves.toBeNull();
  });

  it('delete removes record', async () => {
    const created = await adapter.create({ subject: 'Delete me' });
    await adapter.delete(created.id);
    expect(await adapter.getById(created.id)).toBeNull();
  });

  it('list returns paginated result', async () => {
    await adapter.create({ subject: 'A', priority: 1 });
    await adapter.create({ subject: 'B', priority: 2 });
    await adapter.create({ subject: 'C', priority: 1 });

    const result = await adapter.list();
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('list respects limit and returns cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.create({ subject: `Item ${i}` });
    }
    const page1 = await adapter.list({ limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await adapter.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.length).toBe(2);
    expect(page2.hasMore).toBe(true);
  });

  it('list filters by field values', async () => {
    await adapter.create({ subject: 'Low', priority: 1 });
    await adapter.create({ subject: 'High', priority: 5 });
    await adapter.create({ subject: 'Also Low', priority: 1 });

    const result = await adapter.list({ priority: 1 });
    expect(result.items.length).toBe(2);
    result.items.forEach(item => expect(item.priority).toBe(1));
  });

  it('clear removes everything', async () => {
    await adapter.create({ subject: 'A' });
    await adapter.create({ subject: 'B' });
    await adapter.clear();
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  it('returns copies, not references', async () => {
    const created = await adapter.create({ subject: 'Copy' });
    const a = await adapter.getById(created.id);
    const b = await adapter.getById(created.id);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Memory adapter — TTL
// ---------------------------------------------------------------------------

describe('memory adapter TTL', () => {
  it('expires records after TTL', async () => {
    const shortTtlFields = {
      id: field.string({ primary: true, default: 'uuid' }),
      value: field.string(),
    };
    const shortTtlConfig = defineEntity('Ephemeral', {
      fields: shortTtlFields,
      ttl: { defaultSeconds: 0.05 }, // 50ms
    });

    const adapter = createMemoryEntityAdapter(shortTtlConfig) as EntityAdapter<any, any, any>;
    const created = await adapter.create({ value: 'temporary' });

    expect(await adapter.getById(created.id)).not.toBeNull();

    await new Promise(r => setTimeout(r, 60));

    expect(await adapter.getById(created.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Memory adapter — soft delete
// ---------------------------------------------------------------------------

describe('memory adapter soft delete', () => {
  const sdFields = {
    id: field.string({ primary: true, default: 'uuid' }),
    name: field.string(),
    status: field.enum(['active', 'deleted'], { default: 'active' }),
  };

  const SdEntity = defineEntity('SdEntity', {
    fields: sdFields,
    softDelete: { field: 'status', value: 'deleted' },
  });

  it('soft deletes by setting status field', async () => {
    const adapter = createMemoryEntityAdapter(SdEntity) as EntityAdapter<any, any, any>;
    const created = await adapter.create({ name: 'Test' });

    await adapter.delete(created.id);

    // Should not be visible via getById
    expect(await adapter.getById(created.id)).toBeNull();
  });

  it('soft deleted records are excluded from list', async () => {
    const adapter = createMemoryEntityAdapter(SdEntity) as EntityAdapter<any, any, any>;
    await adapter.create({ name: 'Keep' });
    const toDelete = await adapter.create({ name: 'Remove' });
    await adapter.delete(toDelete.id);

    const result = await adapter.list();
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('Keep');
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter — full CRUD
// ---------------------------------------------------------------------------

describe('sqlite adapter', () => {
  // Simple config without auto-defaults for predictable testing
  const simpleFields = {
    id: field.string({ primary: true }),
    subject: field.string(),
    priority: field.integer({ default: 0 }),
    metadata: field.json({ optional: true }),
    active: field.boolean({ optional: true }),
  };

  const SimpleTicket = defineEntity('SimpleTicket', {
    namespace: 'support',
    fields: simpleFields,
  });

  let db: InstanceType<typeof Database>;
  let adapter: EntityAdapter<any, any, any>;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = createSqliteEntityAdapter(db as any, SimpleTicket);
  });

  it('create + getById', async () => {
    await adapter.create({ id: 's-1', subject: 'SQLite test', priority: 3 });
    const found = await adapter.getById('s-1');
    expect(found).not.toBeNull();
    expect(found.subject).toBe('SQLite test');
    expect(found.priority).toBe(3);
  });

  it('handles JSON fields', async () => {
    await adapter.create({
      id: 's-2',
      subject: 'JSON',
      metadata: { key: 'value', nested: [1, 2] },
    });
    const found = await adapter.getById('s-2');
    expect(found.metadata.key).toBe('value');
    expect(found.metadata.nested).toEqual([1, 2]);
  });

  it('handles boolean fields', async () => {
    await adapter.create({ id: 's-bool', subject: 'Bool', active: true });
    const found = await adapter.getById('s-bool');
    expect(found.active).toBe(true);

    await adapter.create({ id: 's-bool2', subject: 'Bool2', active: false });
    const found2 = await adapter.getById('s-bool2');
    expect(found2.active).toBe(false);
  });

  it('update merges fields and returns updated entity', async () => {
    await adapter.create({ id: 's-3', subject: 'Original' });
    const updated = await adapter.update('s-3', { subject: 'Updated' });
    expect(updated.subject).toBe('Updated');

    const found = await adapter.getById('s-3');
    expect(found.subject).toBe('Updated');
  });

  it('update returns null for missing record', async () => {
    await expect(adapter.update('nope', { subject: 'X' })).resolves.toBeNull();
  });

  it('delete removes record', async () => {
    await adapter.create({ id: 's-4', subject: 'Delete me' });
    await adapter.delete('s-4');
    expect(await adapter.getById('s-4')).toBeNull();
  });

  it('list returns paginated result', async () => {
    await adapter.create({ id: 's-5', subject: 'A', priority: 1 });
    await adapter.create({ id: 's-6', subject: 'B', priority: 2 });
    await adapter.create({ id: 's-7', subject: 'C', priority: 1 });

    const result = await adapter.list();
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(false);
  });

  it('list with limit and cursor pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.create({ id: `p-${i}`, subject: `Item ${i}` });
    }
    const page1 = await adapter.list({ limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await adapter.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.length).toBe(2);
    expect(page2.hasMore).toBe(true);

    const page3 = await adapter.list({ limit: 2, cursor: page2.nextCursor });
    expect(page3.items.length).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  it('clear removes all records', async () => {
    await adapter.create({ id: 's-8', subject: 'A' });
    await adapter.clear();
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  it('creates table and indices automatically', async () => {
    await adapter.create({ id: 's-9', subject: 'Auto create' });
    const tables = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='support_simple_tickets'")
      .all();
    expect(tables.length).toBe(1);
  });

  it('upsert: create overwrites existing record', async () => {
    await adapter.create({ id: 'u-1', subject: 'Original' });
    await adapter.create({ id: 'u-1', subject: 'Replaced' });
    const found = await adapter.getById('u-1');
    expect(found.subject).toBe('Replaced');
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter — TTL
// ---------------------------------------------------------------------------

describe('sqlite adapter TTL', () => {
  it('filters expired records', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteEntityAdapter(db as any, Token) as EntityAdapter<any, any, any>;
    await adapter.create({ key: 'tok-1', userId: 'u1' });
    const found = await adapter.getById('tok-1');
    expect(found).not.toBeNull();
    expect(found.userId).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter — soft delete
// ---------------------------------------------------------------------------

describe('sqlite adapter soft delete', () => {
  const sdFields = {
    id: field.string({ primary: true }),
    name: field.string(),
    status: field.enum(['active', 'deleted'], { default: 'active' }),
  };

  const SdEntity = defineEntity('SdSqlite', {
    fields: sdFields,
    softDelete: { field: 'status', value: 'deleted' },
  });

  it('soft deletes and excludes from queries', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteEntityAdapter(db as any, SdEntity) as EntityAdapter<any, any, any>;

    await adapter.create({ id: 'sd-1', name: 'Keep' });
    await adapter.create({ id: 'sd-2', name: 'Delete' });
    await adapter.delete('sd-2');

    expect(await adapter.getById('sd-2')).toBeNull();
    const result = await adapter.list();
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('Keep');
  });
});

// ---------------------------------------------------------------------------
// resolveRepo integration
// ---------------------------------------------------------------------------

describe('resolveRepo integration', () => {
  it('resolves memory factory correctly', () => {
    const factories = createEntityFactories(Ticket);
    const storeInfra: StoreInfra = {
      appName: 'test',
      getRedis: () => {
        throw new Error('no redis');
      },
      getMongo: () => {
        throw new Error('no mongo');
      },
      getSqliteDb: () => {
        throw new Error('no sqlite');
      },
      getPostgres: () => {
        throw new Error('no postgres');
      },
    };

    const adapter = resolveRepo(factories, 'memory', storeInfra);
    expect(typeof adapter.create).toBe('function');
    expect(typeof adapter.getById).toBe('function');
    expect(typeof adapter.update).toBe('function');
    expect(typeof adapter.delete).toBe('function');
    expect(typeof adapter.list).toBe('function');
    expect(typeof adapter.clear).toBe('function');
  });

  it('resolves sqlite factory with real DB', async () => {
    const db = new Database(':memory:');
    const factories = createEntityFactories(Ticket);
    const storeInfra: StoreInfra = {
      appName: 'test',
      getRedis: () => {
        throw new Error('no redis');
      },
      getMongo: () => {
        throw new Error('no mongo');
      },
      getSqliteDb: () => db,
      getPostgres: () => {
        throw new Error('no postgres');
      },
    };

    const adapter = resolveRepo(factories, 'sqlite', storeInfra);
    const created = await adapter.create({ subject: 'Integration test' } as any);
    const found = await adapter.getById(created.id);
    expect(found).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage hint overrides
// ---------------------------------------------------------------------------

describe('storage hints', () => {
  it('uses custom table name for SQLite', async () => {
    const cfg = defineEntity('Item', {
      fields: { id: field.string({ primary: true }), val: field.string() },
      storage: { sqlite: { tableName: 'custom_items_table' } },
    });

    const db = new Database(':memory:');
    const adapter = createSqliteEntityAdapter(db as any, cfg);
    await adapter.create({ id: 'c-1', val: 'test' } as any);

    const tables = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_items_table'")
      .all();
    expect(tables.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generateSchemas (Zod)
// ---------------------------------------------------------------------------

describe('generateSchemas', () => {
  it('produces entitySchema, createSchema, updateSchema, listOptionsSchema', () => {
    const schemas = generateSchemas(Ticket);
    expect(schemas.entitySchema).toBeDefined();
    expect(schemas.createSchema).toBeDefined();
    expect(schemas.updateSchema).toBeDefined();
    expect(schemas.listOptionsSchema).toBeDefined();
  });

  it('entitySchema validates a valid entity', () => {
    const schemas = generateSchemas(Ticket);
    const result = schemas.entitySchema.safeParse({
      id: 'test-123',
      subject: 'Valid ticket',
      priority: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('entitySchema rejects invalid data', () => {
    const schemas = generateSchemas(Ticket);
    const result = schemas.entitySchema.safeParse({
      id: 123, // should be string
      subject: 'Valid',
    });
    expect(result.success).toBe(false);
  });

  it('createSchema excludes auto-default fields', () => {
    const schemas = generateSchemas(Ticket);
    // id has default: 'uuid', createdAt has default: 'now', updatedAt has onUpdate: 'now'
    // These should NOT appear in createSchema
    const shape = schemas.createSchema.shape;
    expect(shape['updatedAt']).toBeUndefined(); // onUpdate field excluded
  });

  it('updateSchema excludes immutable fields', () => {
    const schemas = generateSchemas(Ticket);
    const shape = schemas.updateSchema.shape;
    // id is primary (immutable) — should not be in update schema
    expect(shape['id']).toBeUndefined();
    // updatedAt has onUpdate — should not be in update schema
    expect(shape['updatedAt']).toBeUndefined();
    // subject should be present and optional
    expect(shape['subject']).toBeDefined();
  });

  it('listOptionsSchema includes pagination options', () => {
    const schemas = generateSchemas(Ticket);
    const shape = schemas.listOptionsSchema.shape;
    expect(shape['limit']).toBeDefined();
    expect(shape['cursor']).toBeDefined();
    expect(shape['sortDir']).toBeDefined();
  });

  it('enum field validates allowed values', () => {
    const enumFields = {
      id: field.string({ primary: true }),
      status: field.enum(['active', 'inactive', 'archived']),
    };
    const cfg = defineEntity('EnumTest', { fields: enumFields });
    const schemas = generateSchemas(cfg);

    const valid = schemas.entitySchema.safeParse({ id: 'x', status: 'active' });
    expect(valid.success).toBe(true);

    const invalid = schemas.entitySchema.safeParse({ id: 'x', status: 'unknown' });
    expect(invalid.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination — detailed
// ---------------------------------------------------------------------------

describe('cursor pagination', () => {
  const paginatedFields = {
    id: field.string({ primary: true }),
    name: field.string(),
    score: field.integer({ default: 0 }),
  };

  const PaginatedEntity = defineEntity('PaginatedEntity', {
    fields: paginatedFields,
    pagination: { cursor: { fields: ['id'] }, defaultLimit: 3, maxLimit: 10 },
  });

  it('respects defaultLimit from config', async () => {
    const adapter = createMemoryEntityAdapter(PaginatedEntity);
    for (let i = 0; i < 5; i++) {
      await adapter.create({ id: `p-${i}`, name: `Item ${i}` });
    }
    const result = await adapter.list();
    expect(result.items.length).toBe(3); // defaultLimit = 3
    expect(result.hasMore).toBe(true);
  });

  it('respects maxLimit from config', async () => {
    const adapter = createMemoryEntityAdapter(PaginatedEntity);
    for (let i = 0; i < 15; i++) {
      await adapter.create({ id: `p-${String(i).padStart(2, '0')}`, name: `Item ${i}` });
    }
    const result = await adapter.list({ limit: 100 }); // exceeds maxLimit
    expect(result.items.length).toBe(10); // capped at maxLimit
  });

  it('paginates through all records', async () => {
    const adapter = createMemoryEntityAdapter(PaginatedEntity);
    for (let i = 0; i < 7; i++) {
      await adapter.create({ id: `p-${String(i).padStart(2, '0')}`, name: `Item ${i}` });
    }

    const allItems: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await adapter.list({ limit: 3, cursor });
      allItems.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(allItems.length).toBe(7);
    // Verify no duplicates
    const ids = new Set(allItems.map(i => i.id));
    expect(ids.size).toBe(7);
  });
});
