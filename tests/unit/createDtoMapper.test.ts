import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createDtoMapper } from '../../src/framework/lib/createDtoMapper';

// ---------------------------------------------------------------------------
// Helpers — simulate DB documents with ObjectId-like values
// ---------------------------------------------------------------------------

function objectId(val: string) {
  return { toString: () => val };
}

// ---------------------------------------------------------------------------
// _id → id mapping
// ---------------------------------------------------------------------------

describe('createDtoMapper — _id → id', () => {
  it('converts _id ObjectId to id string', () => {
    const schema = z.object({ id: z.string(), name: z.string() });
    const toDto = createDtoMapper(schema);
    const doc = { _id: objectId('abc123'), name: 'Alice' };
    const dto = toDto(doc);
    expect(dto.id).toBe('abc123');
    expect((dto as any).name).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// Ref field renaming
// ---------------------------------------------------------------------------

describe('createDtoMapper — refs', () => {
  it('converts db ObjectId ref to string API field', () => {
    const schema = z.object({ id: z.string(), accountId: z.string() });
    const toDto = createDtoMapper(schema, { refs: { account: 'accountId' } });
    const doc = { _id: objectId('user1'), account: objectId('acc42') };
    const dto = toDto(doc);
    expect(dto.accountId).toBe('acc42');
  });

  it('maps multiple refs', () => {
    const schema = z.object({ id: z.string(), ownerId: z.string(), teamId: z.string() });
    const toDto = createDtoMapper(schema, { refs: { owner: 'ownerId', team: 'teamId' } });
    const doc = { _id: objectId('r1'), owner: objectId('u1'), team: objectId('t1') };
    const dto = toDto(doc);
    expect(dto.ownerId).toBe('u1');
    expect(dto.teamId).toBe('t1');
  });
});

// ---------------------------------------------------------------------------
// Date → ISO string
// ---------------------------------------------------------------------------

describe('createDtoMapper — dates', () => {
  it('converts Date fields to ISO strings', () => {
    const schema = z.object({ id: z.string(), createdAt: z.string() });
    const now = new Date('2024-01-15T12:00:00.000Z');
    const toDto = createDtoMapper(schema, { dates: ['createdAt'] });
    const doc = { _id: objectId('d1'), createdAt: now };
    const dto = toDto(doc);
    expect(dto.createdAt).toBe('2024-01-15T12:00:00.000Z');
  });

  it('handles multiple date fields', () => {
    const schema = z.object({ id: z.string(), createdAt: z.string(), updatedAt: z.string() });
    const d1 = new Date('2024-01-01T00:00:00.000Z');
    const d2 = new Date('2024-06-01T00:00:00.000Z');
    const toDto = createDtoMapper(schema, { dates: ['createdAt', 'updatedAt'] });
    const doc = { _id: objectId('d2'), createdAt: d1, updatedAt: d2 };
    const dto = toDto(doc);
    expect(dto.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(dto.updatedAt).toBe('2024-06-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Subdocument arrays
// ---------------------------------------------------------------------------

describe('createDtoMapper — subdocs', () => {
  it('maps subdocument arrays with a custom sub-mapper', () => {
    const tagSchema = (item: any) => ({ label: item.label.toUpperCase() });
    const schema = z.object({ id: z.string(), tags: z.array(z.object({ label: z.string() })) });
    const toDto = createDtoMapper(schema, { subdocs: { tags: tagSchema } });
    const doc = { _id: objectId('s1'), tags: [{ label: 'foo' }, { label: 'bar' }] };
    const dto = toDto(doc);
    expect(dto.tags).toEqual([{ label: 'FOO' }, { label: 'BAR' }]);
  });

  it('treats a missing subdoc array as empty', () => {
    const tagSchema = (item: any) => item;
    const schema = z.object({ id: z.string(), tags: z.array(z.string()) });
    const toDto = createDtoMapper(schema, { subdocs: { tags: tagSchema } });
    const doc = { _id: objectId('s2') }; // tags missing
    const dto = toDto(doc);
    expect(dto.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nullable / optional fields
// ---------------------------------------------------------------------------

describe('createDtoMapper — nullable and optional fields', () => {
  it('coerces undefined optional field to null', () => {
    const schema = z.object({ id: z.string(), bio: z.string().optional() });
    const toDto = createDtoMapper(schema);
    const doc = { _id: objectId('n1') }; // bio missing
    const dto = toDto(doc);
    expect(dto.bio).toBeNull();
  });

  it('coerces undefined nullable field to null', () => {
    const schema = z.object({ id: z.string(), nickname: z.string().nullable() });
    const toDto = createDtoMapper(schema);
    const doc = { _id: objectId('n2') }; // nickname missing
    const dto = toDto(doc);
    expect(dto.nickname).toBeNull();
  });

  it('passes through a value on a nullable field', () => {
    const schema = z.object({ id: z.string(), nickname: z.string().nullable() });
    const toDto = createDtoMapper(schema);
    const doc = { _id: objectId('n3'), nickname: 'Sparky' };
    const dto = toDto(doc);
    expect(dto.nickname).toBe('Sparky');
  });

  it('passes through a required string field as-is', () => {
    const schema = z.object({ id: z.string(), name: z.string() });
    const toDto = createDtoMapper(schema);
    const doc = { _id: objectId('n4'), name: 'Alice' };
    const dto = toDto(doc);
    expect(dto.name).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// ZodDefault unwrap (isNullable branch — line 14 coverage)
// ---------------------------------------------------------------------------

describe('createDtoMapper — ZodDefault nullable unwrap', () => {
  it('treats ZodDefault wrapping ZodNullable as nullable and coerces undefined to null', () => {
    // z.string().nullable().default('') creates ZodDefault wrapping ZodNullable
    // isNullable must unwrap the ZodDefault to find the ZodNullable underneath
    const schema = z.object({ id: z.string(), note: z.string().nullable().default('') });
    const toDto = createDtoMapper(schema);
    const doc = { _id: objectId('x1') }; // note missing → should coerce to null
    const dto = toDto(doc);
    expect(dto.note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toId error branch (line 29 coverage)
// ---------------------------------------------------------------------------

describe('createDtoMapper — toId error', () => {
  it('throws TypeError when _id is not stringifiable', () => {
    const schema = z.object({ id: z.string() });
    const toDto = createDtoMapper(schema);
    // Pass a doc without _id at all (null-ish value will fail stringifiable check)
    expect(() => toDto({ _id: 42 as unknown as any })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Combined transformation
// ---------------------------------------------------------------------------

describe('createDtoMapper — combined', () => {
  it('applies all transformations in a single mapper', () => {
    const schema = z.object({
      id: z.string(),
      name: z.string(),
      ownerId: z.string(),
      createdAt: z.string(),
      bio: z.string().nullable(),
      tags: z.array(z.string()),
    });
    const tagMapper = (t: any) => t.toUpperCase();
    const toDto = createDtoMapper(schema, {
      refs: { owner: 'ownerId' },
      dates: ['createdAt'],
      subdocs: { tags: tagMapper },
    });
    const doc = {
      _id: objectId('combo1'),
      name: 'Test',
      owner: objectId('own1'),
      createdAt: new Date('2024-03-01T00:00:00.000Z'),
      bio: null,
      tags: ['a', 'b'],
    };
    const dto = toDto(doc);
    expect(dto.id).toBe('combo1');
    expect(dto.name).toBe('Test');
    expect(dto.ownerId).toBe('own1');
    expect(dto.createdAt).toBe('2024-03-01T00:00:00.000Z');
    expect(dto.bio).toBeNull();
    expect(dto.tags).toEqual(['A', 'B']);
  });
});
