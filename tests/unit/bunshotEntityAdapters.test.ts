/**
 * Tests that generated adapter code actually works.
 *
 * Strategy: generate source strings → write to temp files → import → run CRUD.
 * This proves the generated code is valid TypeScript that runs correctly.
 */
import { Database } from 'bun:sqlite';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defineEntity, field, generate, index } from '../../packages/slingshot-entity/src/index';

// ---------------------------------------------------------------------------
// Minimal adapter shape for typing dynamic imports
// ---------------------------------------------------------------------------

interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

interface TestRecord {
  id: string;
  subject?: string;
  name?: string;
  status?: string;
  priority?: number;
  metadata?: unknown;
  active?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

interface TestAdapter {
  create(input: Record<string, unknown>): Promise<TestRecord>;
  getById(id: string, filter?: Record<string, unknown>): Promise<TestRecord | null>;
  update(
    id: string,
    input: Record<string, unknown>,
    filter?: Record<string, unknown>,
  ): Promise<TestRecord | null>;
  delete(id: string, filter?: Record<string, unknown>): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<PaginatedResult<TestRecord>>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Test entity
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
  pagination: { cursor: { fields: ['id'] }, defaultLimit: 3, maxLimit: 10 },
});

const sdFields = {
  id: field.string({ primary: true, default: 'uuid' }),
  name: field.string(),
  status: field.enum(['active', 'deleted'], { default: 'active' }),
};

const SdEntity = defineEntity('SdEntity', {
  fields: sdFields,
  softDelete: { field: 'status', value: 'deleted' },
});

// ---------------------------------------------------------------------------
// Generate and write files
// ---------------------------------------------------------------------------

const tmpDir = join(import.meta.dir, '..', '..', '.tmp-generated-ticket');
const sdTmpDir = join(import.meta.dir, '..', '..', '.tmp-generated-sd');

beforeAll(() => {
  // Generate and write Ticket files
  const ticketFiles = generate(Ticket, { backends: ['memory', 'sqlite'] });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const [filename, content] of Object.entries(ticketFiles)) {
    writeFileSync(join(tmpDir, filename), content, 'utf-8');
  }

  // Generate and write SdEntity files
  const sdFiles = generate(SdEntity, { backends: ['memory'] });
  rmSync(sdTmpDir, { recursive: true, force: true });
  mkdirSync(sdTmpDir, { recursive: true });
  for (const [filename, content] of Object.entries(sdFiles)) {
    writeFileSync(join(sdTmpDir, filename), content, 'utf-8');
  }
});

// ---------------------------------------------------------------------------
// Memory adapter — generated code CRUD
// ---------------------------------------------------------------------------

describe('generated memory adapter', () => {
  let createAdapter: () => TestAdapter;

  beforeAll(async () => {
    const mod = await import(join(tmpDir, 'memory.ts'));
    createAdapter = mod.createMemoryTicketAdapter;
  });

  it('factory function exists', () => {
    expect(typeof createAdapter).toBe('function');
  });

  it('create applies auto-defaults and returns entity', async () => {
    const adapter = createAdapter();
    const result = await adapter.create({ subject: 'Test ticket' });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.subject).toBe('Test ticket');
    expect(result.priority).toBe(0); // literal default
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('getById returns created record', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ subject: 'Find me' });
    const found = await adapter.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.subject).toBe('Find me');
  });

  it('getById returns null for missing record', async () => {
    const adapter = createAdapter();
    expect(await adapter.getById('nonexistent')).toBeNull();
  });

  it('update merges fields and returns updated entity', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ subject: 'Original' });
    const updated = await adapter.update(created.id, { subject: 'Updated', priority: 5 });
    expect(updated!.subject).toBe('Updated');
    expect(updated!.priority).toBe(5);
    expect(updated!.id).toBe(created.id);
  });

  it('update sets onUpdate fields', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ subject: 'Test' });
    const before = created.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = await adapter.update(created.id, { subject: 'Changed' });
    expect(updated!.updatedAt!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });

  it('update returns null for missing record', async () => {
    const adapter = createAdapter();
    await expect(adapter.update('nope', { subject: 'X' })).resolves.toBeNull();
  });

  it('delete removes record', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ subject: 'Delete me' });
    await adapter.delete(created.id);
    expect(await adapter.getById(created.id)).toBeNull();
  });

  it('list returns paginated result', async () => {
    const adapter = createAdapter();
    await adapter.create({ subject: 'A' });
    await adapter.create({ subject: 'B' });
    const result = await adapter.list();
    expect(result.items.length).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('list respects limit and returns cursor', async () => {
    const adapter = createAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.create({ subject: `Item ${i}` });
    }
    const page1 = await adapter.list({ limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await adapter.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.length).toBe(2);
  });

  it('list filters by field values', async () => {
    const adapter = createAdapter();
    await adapter.create({ subject: 'Low', priority: 1 });
    await adapter.create({ subject: 'High', priority: 5 });
    await adapter.create({ subject: 'Also Low', priority: 1 });
    const result = await adapter.list({ priority: 1 });
    expect(result.items.length).toBe(2);
    for (const item of result.items) {
      expect(item.priority).toBe(1);
    }
  });

  it('clear removes everything', async () => {
    const adapter = createAdapter();
    await adapter.create({ subject: 'A' });
    await adapter.create({ subject: 'B' });
    await adapter.clear();
    const result = await adapter.list();
    expect(result.items.length).toBe(0);
  });

  it('respects defaultLimit from config', async () => {
    const adapter = createAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.create({ subject: `Item ${i}` });
    }
    const result = await adapter.list();
    expect(result.items.length).toBe(3); // defaultLimit = 3
    expect(result.hasMore).toBe(true);
  });

  it('respects maxLimit from config', async () => {
    const adapter = createAdapter();
    for (let i = 0; i < 15; i++) {
      await adapter.create({ subject: `Item ${i}` });
    }
    const result = await adapter.list({ limit: 100 });
    expect(result.items.length).toBe(10); // maxLimit = 10
  });

  it('paginates through all records', async () => {
    const adapter = createAdapter();
    for (let i = 0; i < 7; i++) {
      await adapter.create({ subject: `Item ${i}` });
    }
    const allItems: TestRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await adapter.list({ limit: 3, cursor });
      allItems.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(allItems.length).toBe(7);
    const ids = new Set(allItems.map(i => i.id));
    expect(ids.size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Memory adapter — soft delete (generated)
// ---------------------------------------------------------------------------

describe('generated memory adapter soft delete', () => {
  let createAdapter: () => TestAdapter;

  beforeAll(async () => {
    const mod = await import(join(sdTmpDir, 'memory.ts'));
    createAdapter = mod.createMemorySdEntityAdapter;
  });

  it('soft deletes by setting status field', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ name: 'Test' });
    await adapter.delete(created.id);
    expect(await adapter.getById(created.id)).toBeNull();
  });

  it('soft deleted records excluded from list', async () => {
    const adapter = createAdapter();
    await adapter.create({ name: 'Keep' });
    const toDelete = await adapter.create({ name: 'Remove' });
    await adapter.delete(toDelete.id);
    const result = await adapter.list();
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('Keep');
  });

  it('double delete is idempotent (guard prevents re-deleting)', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ name: 'Once' });
    await adapter.delete(created.id);
    // Second delete should not throw or change state
    await adapter.delete(created.id);
    expect(await adapter.getById(created.id)).toBeNull();
  });

  it('update on soft-deleted record returns null', async () => {
    const adapter = createAdapter();
    const created = await adapter.create({ name: 'Gone' });
    await adapter.delete(created.id);
    await expect(adapter.update(created.id, { name: 'Revived' })).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SQLite adapter — generated code CRUD
// ---------------------------------------------------------------------------

describe('generated sqlite adapter', () => {
  let createSqliteAdapter: (db: Database) => TestAdapter;

  beforeAll(async () => {
    const mod = await import(join(tmpDir, 'sqlite.ts'));
    createSqliteAdapter = mod.createSqliteTicketAdapter;
  });

  it('factory function exists', () => {
    expect(typeof createSqliteAdapter).toBe('function');
  });

  it('create + getById', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    const created = await adapter.create({ subject: 'SQLite test', priority: 3 });
    expect(typeof created.id).toBe('string');
    const found = await adapter.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.subject).toBe('SQLite test');
    expect(found!.priority).toBe(3);
  });

  it('handles JSON fields', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    const created = await adapter.create({
      subject: 'JSON',
      metadata: { key: 'value', nested: [1, 2] },
    });
    const found = await adapter.getById(created.id);
    const meta = found!.metadata as { key: string; nested: number[] };
    expect(meta.key).toBe('value');
    expect(meta.nested).toEqual([1, 2]);
  });

  it('handles boolean fields', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    const created = await adapter.create({ subject: 'Bool', active: true });
    const found = await adapter.getById(created.id);
    expect(found!.active).toBe(true);
  });

  it('update merges fields', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    const created = await adapter.create({ subject: 'Original' });
    const updated = await adapter.update(created.id, { subject: 'Updated' });
    expect(updated!.subject).toBe('Updated');
  });

  it('delete removes record', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    const created = await adapter.create({ subject: 'Delete me' });
    await adapter.delete(created.id);
    expect(await adapter.getById(created.id)).toBeNull();
  });

  it('list with cursor pagination', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    for (let i = 0; i < 5; i++) {
      await adapter.create({ subject: `Item ${i}` });
    }
    const page1 = await adapter.list({ limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await adapter.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.length).toBe(2);
  });

  it('clear removes all records', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    await adapter.create({ subject: 'A' });
    await adapter.clear();
    const result = await adapter.list();
    expect(result.items.length).toBe(0);
  });

  it('upsert: create overwrites existing record', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    const created = await adapter.create({ subject: 'Original' });
    // Create with same explicit id should upsert
    await adapter.create({ subject: 'Replaced', id: created.id });
    const found = await adapter.getById(created.id);
    expect(found!.subject).toBe('Replaced');
  });

  it('creates table automatically', async () => {
    const db = new Database(':memory:');
    const adapter = createSqliteAdapter(db);
    await adapter.create({ subject: 'Auto create' });
    const tables = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='support_tickets'")
      .all();
    expect(tables.length).toBe(1);
  });
});
