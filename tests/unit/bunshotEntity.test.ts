import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  defineEntity,
  defineOperations,
  field,
  generate,
  index,
  op,
  writeGenerated,
} from '../../packages/slingshot-entity/src/index';

// ---------------------------------------------------------------------------
// Test entity definitions
// ---------------------------------------------------------------------------

const messageFields = {
  id: field.string({ primary: true, default: 'uuid' }),
  roomId: field.string(),
  content: field.string(),
  type: field.enum(['text', 'image', 'system'], { default: 'text' }),
  metadata: field.json({ optional: true }),
  pinned: field.boolean({ optional: true }),
  createdAt: field.date({ default: 'now' }),
  updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
};

const Message = defineEntity('Message', {
  namespace: 'chat',
  fields: messageFields,
  indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
  pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 50, maxLimit: 200 },
  defaultSort: { field: 'createdAt', direction: 'desc' },
});

const simpleFields = {
  id: field.string({ primary: true }),
  name: field.string(),
  score: field.integer({ default: 0 }),
};

const SimpleEntity = defineEntity('SimpleEntity', {
  fields: simpleFields,
});

const softDeleteFields = {
  id: field.string({ primary: true, default: 'uuid' }),
  title: field.string(),
  status: field.enum(['active', 'deleted'], { default: 'active' }),
};

const SdEntity = defineEntity('SdEntity', {
  fields: softDeleteFields,
  softDelete: { field: 'status', value: 'deleted' },
});

// ---------------------------------------------------------------------------
// generate() pure function tests
// ---------------------------------------------------------------------------

describe('generate() pure function', () => {
  it('returns all expected file keys', () => {
    const files = generate(Message);
    expect(Object.keys(files).sort()).toEqual([
      'adapter.ts',
      'index.ts',
      'memory.ts',
      'mongo.ts',
      'postgres.ts',
      'redis.ts',
      'schemas.ts',
      'sqlite.ts',
      'types.ts',
    ]);
  });

  it('respects backends option', () => {
    const files = generate(Message, { backends: ['memory', 'sqlite'] });
    expect(Object.keys(files).sort()).toEqual([
      'adapter.ts',
      'index.ts',
      'memory.ts',
      'schemas.ts',
      'sqlite.ts',
      'types.ts',
    ]);
    expect(files['index.ts']).not.toContain('mongo');
    expect(files['index.ts']).not.toContain('postgres');
    expect(files['index.ts']).not.toContain('redis');
  });
});

// ---------------------------------------------------------------------------
// types.ts output
// ---------------------------------------------------------------------------

describe('generated types.ts', () => {
  it('contains entity interface with all fields', () => {
    const files = generate(Message);
    const types = files['types.ts'];
    expect(types).toContain('export interface Message {');
    expect(types).toContain('id: string;');
    expect(types).toContain('roomId: string;');
    expect(types).toContain('content: string;');
    expect(types).toContain("type: 'text' | 'image' | 'system';");
    expect(types).toContain('metadata?: unknown;');
    expect(types).toContain('pinned?: boolean;');
    expect(types).toContain('createdAt: Date;');
    expect(types).toContain('updatedAt: Date;');
  });

  it('contains CreateInput excluding auto-defaults and onUpdate', () => {
    const files = generate(Message);
    const types = files['types.ts'];
    expect(types).toContain('export interface CreateMessageInput {');
    // id (default: uuid) → excluded
    expect(types).not.toMatch(/CreateMessageInput[\s\S]*?id[?]?:/);
    // createdAt (default: now) → excluded
    // updatedAt (onUpdate: now) → excluded
    expect(types).toContain('roomId: string;');
    expect(types).toContain('content: string;');
    // type has literal default → optional in create
    expect(types).toMatch(/type\?: /);
  });

  it('contains UpdateInput excluding immutable and onUpdate fields', () => {
    const files = generate(Message);
    const types = files['types.ts'];
    expect(types).toContain('export interface UpdateMessageInput {');
    // id is primary/immutable → excluded
    // updatedAt is onUpdate → excluded
    expect(types).toContain('content?: string;');
    expect(types).toContain('roomId?: string;');
  });

  it('contains Id type alias', () => {
    const files = generate(Message);
    expect(files['types.ts']).toContain('export type MessageId = string;');
  });

  it('has no external imports', () => {
    const files = generate(Message);
    expect(files['types.ts']).not.toContain('import');
  });
});

// ---------------------------------------------------------------------------
// schemas.ts output
// ---------------------------------------------------------------------------

describe('generated schemas.ts', () => {
  it('imports only zod', () => {
    const files = generate(Message);
    const schemas = files['schemas.ts'];
    expect(schemas).toContain("import { z } from 'zod';");
    // Should have exactly one import line
    const importLines = schemas.split('\n').filter(l => l.startsWith('import'));
    expect(importLines.length).toBe(1);
  });

  it('contains entity, create, update, and list schemas', () => {
    const files = generate(Message);
    const schemas = files['schemas.ts'];
    expect(schemas).toContain('export const messageSchema = z.object({');
    expect(schemas).toContain('export const createMessageSchema = z.object({');
    expect(schemas).toContain('export const updateMessageSchema = z.object({');
    expect(schemas).toContain('export const listMessageOptionsSchema = z.object({');
  });

  it('entity schema has all fields with correct zod types', () => {
    const files = generate(Message);
    const schemas = files['schemas.ts'];
    expect(schemas).toContain('id: z.string(),');
    expect(schemas).toContain("type: z.enum(['text', 'image', 'system']),");
    expect(schemas).toContain('metadata: z.unknown().nullable().optional(),');
    expect(schemas).toContain('createdAt: z.coerce.date(),');
  });

  it('list schema includes pagination options', () => {
    const files = generate(Message);
    const schemas = files['schemas.ts'];
    expect(schemas).toContain('limit: z.number().int().positive().optional(),');
    expect(schemas).toContain('cursor: z.string().optional(),');
    expect(schemas).toContain("sortDir: z.enum(['asc', 'desc']).optional(),");
  });
});

// ---------------------------------------------------------------------------
// adapter.ts output
// ---------------------------------------------------------------------------

describe('generated adapter.ts', () => {
  it('imports only from sibling types.ts', () => {
    const files = generate(Message);
    const adapter = files['adapter.ts'];
    expect(adapter).toContain("from './types'");
    const importLines = adapter.split('\n').filter(l => l.startsWith('import'));
    expect(importLines.length).toBe(1);
  });

  it('contains PaginatedResult and ListOptions types', () => {
    const files = generate(Message);
    const adapter = files['adapter.ts'];
    expect(adapter).toContain('export interface PaginatedResult<T>');
    expect(adapter).toContain('export interface ListOptions');
  });

  it('contains typed adapter interface', () => {
    const files = generate(Message);
    const adapter = files['adapter.ts'];
    expect(adapter).toContain('export interface MessageAdapter {');
    expect(adapter).toContain('create(input: CreateMessageInput): Promise<Message>;');
    expect(adapter).toContain(
      'getById(id: string, filter?: Record<string, unknown>): Promise<Message | null>;',
    );
    expect(adapter).toContain(
      'update(id: string, input: UpdateMessageInput, filter?: Record<string, unknown>): Promise<Message | null>;',
    );
    expect(adapter).toContain(
      'delete(id: string, filter?: Record<string, unknown>): Promise<boolean>;',
    );
    expect(adapter).toContain('list(opts?: ListOptions): Promise<PaginatedResult<Message>>;');
    expect(adapter).toContain('clear(): Promise<void>;');
  });
});

// ---------------------------------------------------------------------------
// memory.ts output
// ---------------------------------------------------------------------------

describe('generated memory.ts', () => {
  it('imports only from sibling types.ts and adapter.ts', () => {
    const files = generate(Message);
    const memory = files['memory.ts'];
    const importLines = memory.split('\n').filter(l => l.startsWith('import'));
    expect(importLines.length).toBe(2);
    expect(memory).toContain("from './types'");
    expect(memory).toContain("from './adapter'");
  });

  it('exports factory function with correct name', () => {
    const files = generate(Message);
    expect(files['memory.ts']).toContain('export function createMemoryMessageAdapter()');
  });

  it('contains auto-default logic for uuid and now fields', () => {
    const files = generate(Message);
    const memory = files['memory.ts'];
    expect(memory).toContain('crypto.randomUUID()');
    expect(memory).toContain('new Date()');
  });

  it('contains soft-delete logic when configured', () => {
    const files = generate(SdEntity);
    const memory = files['memory.ts'];
    expect(memory).toContain("'status'");
    expect(memory).toContain("'deleted'");
    expect(memory).toContain('recordVisible');
  });

  it('does NOT contain soft-delete logic when not configured', () => {
    const files = generate(SimpleEntity);
    const memory = files['memory.ts'];
    expect(memory).not.toContain('recordVisible');
    // Delete should be a simple store.delete
    expect(memory).toContain('store.delete(id)');
  });
});

// ---------------------------------------------------------------------------
// sqlite.ts output
// ---------------------------------------------------------------------------

describe('generated sqlite.ts', () => {
  it('imports from bun:sqlite and sibling files', () => {
    const files = generate(Message);
    const sqlite = files['sqlite.ts'];
    expect(sqlite).toContain("import type { Database } from 'bun:sqlite'");
    expect(sqlite).toContain("from './types'");
    expect(sqlite).toContain("from './adapter'");
  });

  it('contains CREATE TABLE with correct column types', () => {
    const files = generate(Message);
    const sqlite = files['sqlite.ts'];
    expect(sqlite).toContain('id TEXT PRIMARY KEY NOT NULL');
    expect(sqlite).toContain('room_id TEXT NOT NULL');
    expect(sqlite).toContain('content TEXT NOT NULL');
    expect(sqlite).toContain('type TEXT NOT NULL');
    expect(sqlite).toContain('metadata TEXT');
    expect(sqlite).toContain('created_at INTEGER NOT NULL');
  });

  it('creates compound indexes', () => {
    const files = generate(Message);
    const sqlite = files['sqlite.ts'];
    expect(sqlite).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sqlite).toContain('room_id, created_at');
  });

  it('exports factory function', () => {
    const files = generate(Message);
    expect(files['sqlite.ts']).toContain(
      'export function createSqliteMessageAdapter(db: Database)',
    );
  });
});

// ---------------------------------------------------------------------------
// postgres.ts output
// ---------------------------------------------------------------------------

describe('generated postgres.ts', () => {
  it('imports from pg', () => {
    const files = generate(Message);
    expect(files['postgres.ts']).toContain("import type { Pool } from 'pg'");
  });

  it('uses parameterized queries ($1, $2)', () => {
    const files = generate(Message);
    const pg = files['postgres.ts'];
    expect(pg).toContain('$1');
    expect(pg).toContain('$${');
  });

  it('uses UPSERT with ON CONFLICT', () => {
    const files = generate(Message);
    expect(files['postgres.ts']).toContain('ON CONFLICT');
    expect(files['postgres.ts']).toContain('EXCLUDED');
  });

  it('contains TIMESTAMPTZ for date columns', () => {
    const files = generate(Message);
    expect(files['postgres.ts']).toContain('TIMESTAMPTZ');
  });
});

// ---------------------------------------------------------------------------
// mongo.ts output
// ---------------------------------------------------------------------------

describe('generated mongo.ts', () => {
  it('imports from mongoose', () => {
    const files = generate(Message);
    expect(files['mongo.ts']).toContain("from 'mongoose'");
  });

  it('maps PK to _id', () => {
    const files = generate(Message);
    const mongo = files['mongo.ts'];
    expect(mongo).toContain("doc['_id']");
  });

  it('creates Mongoose schema with correct types', () => {
    const files = generate(Message);
    const mongo = files['mongo.ts'];
    expect(mongo).toContain('type: String');
    expect(mongo).toContain('type: Date');
  });
});

// ---------------------------------------------------------------------------
// redis.ts output
// ---------------------------------------------------------------------------

describe('generated redis.ts', () => {
  it('defines RedisClient interface (no external import)', () => {
    const files = generate(Message);
    const redis = files['redis.ts'];
    expect(redis).toContain('export interface RedisClient {');
    // No import from ioredis or similar
    const importLines = redis.split('\n').filter(l => l.startsWith('import'));
    // Only imports from sibling files
    for (const line of importLines) {
      expect(line).toContain("from './");
    }
  });

  it('uses SCAN for listing', () => {
    const files = generate(Message);
    expect(files['redis.ts']).toContain('scanAllKeys');
    expect(files['redis.ts']).toContain("'MATCH'");
  });

  it('stores dates as ISO strings', () => {
    const files = generate(Message);
    expect(files['redis.ts']).toContain('toISOString()');
  });
});

// ---------------------------------------------------------------------------
// index.ts barrel export
// ---------------------------------------------------------------------------

describe('generated index.ts', () => {
  it('re-exports all sibling modules', () => {
    const files = generate(Message);
    const barrel = files['index.ts'];
    expect(barrel).toContain("export * from './types'");
    expect(barrel).toContain("export * from './schemas'");
    expect(barrel).toContain("export * from './adapter'");
    expect(barrel).toContain("export * from './memory'");
    expect(barrel).toContain("export * from './sqlite'");
    expect(barrel).toContain("export * from './postgres'");
    expect(barrel).toContain("export * from './mongo'");
    expect(barrel).toContain("export * from './redis'");
  });

  it('omits backends not in options', () => {
    const files = generate(Message, { backends: ['memory'] });
    const barrel = files['index.ts'];
    expect(barrel).toContain("export * from './memory'");
    expect(barrel).not.toContain("export * from './sqlite'");
    expect(barrel).not.toContain("export * from './postgres'");
  });
});

// ---------------------------------------------------------------------------
// Generated output has NO slingshot-entity imports
// ---------------------------------------------------------------------------

describe('zero slingshot-entity runtime dependency', () => {
  it('no generated file imports from slingshot-entity or slingshot-core', () => {
    const files = generate(Message);
    for (const [, content] of Object.entries(files)) {
      // Check actual import statements, not comments
      const importLines = content.split('\n').filter(l => l.startsWith('import'));
      for (const line of importLines) {
        expect(line).not.toContain('slingshot-entity');
        expect(line).not.toContain('slingshot-core');
        // Only allowed sources: sibling files, zod, bun:sqlite, pg, mongoose
        const fromMatch = line.match(/from ['"](.+)['"]/);
        if (fromMatch) {
          const source = fromMatch[1];
          expect(
            source.startsWith('./') ||
              source === 'zod' ||
              source === 'bun:sqlite' ||
              source === 'pg' ||
              source === 'mongoose',
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Generated search with logical filters — end-to-end
// ---------------------------------------------------------------------------

describe('generated search with $and/$or filters', () => {
  it('self-contained output with no slingshot-core import', () => {
    const Entity = defineEntity('Item', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['active', 'deleted'], { default: 'active' }),
      },
    });
    const ops = defineOperations(Entity, {
      search: op.search({
        fields: ['content'],
        filter: { $and: [{ roomId: 'param:roomId' }, { status: { $ne: 'deleted' } }] },
      }),
    });
    const files = generate(Entity, { operations: ops.operations });
    const mem = files['memory.ts'];

    // No external slingshot-core import
    const importLines = mem.split('\n').filter((l: string) => l.startsWith('import'));
    for (const line of importLines) {
      expect(line).not.toContain('slingshot-core');
    }

    // Has inline filter evaluator
    expect(mem).toContain('__matchFilter');
    expect(mem).toContain("'$and'");
    expect(mem).toContain("'$ne'");
  });

  it('generated adapter executes filtered search correctly', async () => {
    // Use the runtime path (not codegen) to prove filter logic works end-to-end
    const Entity = defineEntity('Item', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        roomId: field.string(),
        content: field.string(),
        status: field.enum(['active', 'deleted'], { default: 'active' }),
      },
    });
    const ops = defineOperations(Entity, {
      filteredSearch: op.search({
        fields: ['content'],
        filter: { $and: [{ roomId: 'param:roomId' }, { status: { $ne: 'deleted' } }] },
      }),
    });

    const { createEntityFactories } = await import('@lastshotlabs/slingshot-entity');
    const adapter = createEntityFactories(Entity, ops.operations).memory() as any;

    await adapter.create({ roomId: 'r1', content: 'hello world' });
    await adapter.create({ roomId: 'r1', content: 'hello again', status: 'deleted' });
    await adapter.create({ roomId: 'r2', content: 'hello other room' });
    await adapter.create({ roomId: 'r1', content: 'goodbye' });

    // Search with $and filter: roomId=r1 AND status != deleted
    const results = await (adapter as unknown as Record<string, (...args: unknown[]) => unknown>).filteredSearch('hello', {
      roomId: 'r1',
    });

    // Should find only "hello world" — "hello again" is deleted, "hello other room" is r2
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe('hello world');
  });

  it('handles $or filters at runtime', async () => {
    const Entity = defineEntity('Item', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        category: field.string(),
        content: field.string(),
      },
    });
    const ops = defineOperations(Entity, {
      searchByCategory: op.search({
        fields: ['content'],
        filter: { $or: [{ category: 'param:cat1' }, { category: 'param:cat2' }] },
      }),
    });

    const { createEntityFactories } = await import('@lastshotlabs/slingshot-entity');
    const adapter = createEntityFactories(Entity, ops.operations).memory() as any;

    await adapter.create({ category: 'tech', content: 'typescript is great' });
    await adapter.create({ category: 'food', content: 'typescript cookies' });
    await adapter.create({ category: 'sports', content: 'typescript league' });

    const results = await (adapter as unknown as Record<string, (...args: unknown[]) => unknown>).searchByCategory(
      'typescript',
      {
        cat1: 'tech',
        cat2: 'food',
      },
    );

    expect(results.length).toBe(2);
    const categories = results.map((r: Record<string, unknown>) => r.category).sort();
    expect(categories).toEqual(['food', 'tech']);
  });
});

// ---------------------------------------------------------------------------
// defineEntity() validation errors
// ---------------------------------------------------------------------------

describe('defineEntity validation', () => {
  it('throws on missing primary key', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: {
          name: field.string(),
        },
      }),
    ).toThrow('No primary key field defined');
  });

  it('throws on multiple primary keys', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: {
          id: field.string({ primary: true }),
          code: field.string({ primary: true }),
        },
      }),
    ).toThrow('Multiple primary key fields');
  });

  it('throws on invalid primary key type', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: {
          id: field.boolean({ primary: true }),
        },
      }),
    ).toThrow('must be string, number, or integer');
  });

  it('throws on softDelete referencing nonexistent field', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: { id: field.string({ primary: true }) },
        softDelete: { field: 'ghost', value: 'deleted' },
      }),
    ).toThrow("softDelete.field 'ghost' not found");
  });

  it('throws on index referencing unknown field', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: { id: field.string({ primary: true }) },
        indexes: [index(['ghost'])],
      }),
    ).toThrow("Index references unknown field 'ghost'");
  });

  it('throws on pagination cursor referencing unknown field', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: { id: field.string({ primary: true }) },
        pagination: { cursor: { fields: ['ghost'] } },
      }),
    ).toThrow("pagination.cursor references unknown field 'ghost'");
  });

  it('throws on tenant referencing nonexistent field', () => {
    expect(() =>
      defineEntity('Bad', {
        fields: { id: field.string({ primary: true }) },
        tenant: { field: 'orgId' },
      }),
    ).toThrow("tenant.field 'orgId' not found");
  });
});

// ---------------------------------------------------------------------------
// Extended field types: number, stringArray, CUID
// ---------------------------------------------------------------------------

describe('extended field types in generated output', () => {
  const AllFields = defineEntity('AllFields', {
    fields: {
      id: field.string({ primary: true, default: 'cuid' }),
      score: field.number(),
      rank: field.integer({ optional: true }),
      tags: field.stringArray({ optional: true }),
      name: field.string(),
    },
  });

  it('generates number field as number type', () => {
    const files = generate(AllFields);
    expect(files['types.ts']).toContain('score: number;');
    expect(files['schemas.ts']).toContain('score: z.number(),');
  });

  it('generates stringArray field as string[] type', () => {
    const files = generate(AllFields);
    expect(files['types.ts']).toContain('tags?: string[];');
    expect(files['schemas.ts']).toContain('z.array(z.string())');
  });

  it('generates CUID default', () => {
    const files = generate(AllFields);
    const memory = files['memory.ts'];
    expect(memory).toContain('Date.now().toString(36)');
    expect(memory).toContain('Math.random().toString(36)');
  });

  it('generates integer field with z.number().int()', () => {
    const files = generate(AllFields);
    expect(files['schemas.ts']).toContain('z.number().int()');
  });
});

// ---------------------------------------------------------------------------
// writeGenerated / CLI
// ---------------------------------------------------------------------------

describe('writeGenerated', () => {
  const cliTmpDir = join(import.meta.dir, '..', '..', '.tmp-generated-cli');

  const CliEntity = defineEntity('CliEntity', {
    fields: {
      id: field.string({ primary: true, default: 'uuid' }),
      label: field.string(),
    },
  });

  it('writes files to disk', () => {
    rmSync(cliTmpDir, { recursive: true, force: true });
    const result = writeGenerated(CliEntity, { outDir: cliTmpDir, backends: ['memory'] });
    expect(existsSync(join(cliTmpDir, 'types.ts'))).toBe(true);
    expect(existsSync(join(cliTmpDir, 'memory.ts'))).toBe(true);
    expect(existsSync(join(cliTmpDir, 'index.ts'))).toBe(true);
    const diskContent = readFileSync(join(cliTmpDir, 'types.ts'), 'utf-8');
    expect(diskContent).toBe(result['types.ts']);
    rmSync(cliTmpDir, { recursive: true, force: true });
  });

  it('skips unchanged files', () => {
    rmSync(cliTmpDir, { recursive: true, force: true });
    writeGenerated(CliEntity, { outDir: cliTmpDir, backends: ['memory'] });
    const result2 = writeGenerated(CliEntity, { outDir: cliTmpDir, backends: ['memory'] });
    const diskContent = readFileSync(join(cliTmpDir, 'types.ts'), 'utf-8');
    expect(diskContent).toBe(result2['types.ts']);
    rmSync(cliTmpDir, { recursive: true, force: true });
  });

  it('dryRun returns files without writing', () => {
    rmSync(cliTmpDir, { recursive: true, force: true });
    const result = writeGenerated(CliEntity, {
      outDir: cliTmpDir,
      dryRun: true,
      backends: ['memory'],
    });
    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(existsSync(cliTmpDir)).toBe(false);
  });
});
