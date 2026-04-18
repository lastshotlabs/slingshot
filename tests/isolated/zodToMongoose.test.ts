import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { zodToMongoose } from '../../src/framework/lib/zodToMongoose';

// ---------------------------------------------------------------------------
// Basic scalar type mapping
// ---------------------------------------------------------------------------

describe('zodToMongoose — scalar types', () => {
  it('maps z.string() → { type: String, required: true }', () => {
    const result = zodToMongoose(z.object({ name: z.string() }));
    expect(result.name).toMatchObject({ type: String, required: true });
  });

  it('maps z.number() → { type: Number, required: true }', () => {
    const result = zodToMongoose(z.object({ age: z.number() }));
    expect(result.age).toMatchObject({ type: Number, required: true });
  });

  it('maps z.boolean() → { type: Boolean, required: true }', () => {
    const result = zodToMongoose(z.object({ active: z.boolean() }));
    expect(result.active).toMatchObject({ type: Boolean, required: true });
  });

  it('maps z.date() → { type: Date, required: true }', () => {
    const result = zodToMongoose(z.object({ createdAt: z.date() }));
    expect(result.createdAt).toMatchObject({ type: Date, required: true });
  });

  it('maps z.enum() → { type: String, enum: [...], required: true }', () => {
    const result = zodToMongoose(z.object({ status: z.enum(['active', 'inactive']) }));
    expect(result.status).toMatchObject({
      type: String,
      enum: ['active', 'inactive'],
      required: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Optional / nullable fields → required: false
// ---------------------------------------------------------------------------

describe('zodToMongoose — optional and nullable fields', () => {
  it('optional string → required: false', () => {
    const result = zodToMongoose(z.object({ bio: z.string().optional() }));
    expect((result.bio as any).required).toBe(false);
    expect((result.bio as any).type).toBe(String);
  });

  it('nullable string → required: false', () => {
    const result = zodToMongoose(z.object({ nickname: z.string().nullable() }));
    expect((result.nickname as any).required).toBe(false);
    expect((result.nickname as any).type).toBe(String);
  });

  it('string with default → required: false', () => {
    const result = zodToMongoose(z.object({ role: z.string().default('user') }));
    expect((result.role as any).required).toBe(false);
    expect((result.role as any).type).toBe(String);
  });
});

// ---------------------------------------------------------------------------
// id field exclusion
// ---------------------------------------------------------------------------

describe('zodToMongoose — id exclusion', () => {
  it("excludes the 'id' field (Mongoose provides _id)", () => {
    const result = zodToMongoose(z.object({ id: z.string(), name: z.string() }));
    expect(result).not.toHaveProperty('id');
    expect(result).toHaveProperty('name');
  });
});

// ---------------------------------------------------------------------------
// refs config
// ---------------------------------------------------------------------------

describe('zodToMongoose — refs config', () => {
  it('maps a ref field to ObjectId with correct ref and required: true', () => {
    const result = zodToMongoose(z.object({ ownerId: z.string() }), {
      refs: { ownerId: { dbField: 'owner', ref: 'User' } },
    });
    // ownerId is mapped to the dbField "owner"
    expect(result).not.toHaveProperty('ownerId');
    expect(result.owner).toBeDefined();
    expect((result.owner as any).ref).toBe('User');
    expect((result.owner as any).required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// typeOverrides config
// ---------------------------------------------------------------------------

describe('zodToMongoose — typeOverrides config', () => {
  it('replaces auto-detected type with the override', () => {
    const override = { type: String, index: true, unique: true };
    const result = zodToMongoose(z.object({ email: z.string() }), {
      typeOverrides: { email: override },
    });
    expect(result.email).toBe(override);
  });
});

// ---------------------------------------------------------------------------
// dbFields config
// ---------------------------------------------------------------------------

describe('zodToMongoose — dbFields config', () => {
  it('merges db-only fields into the result', () => {
    const userRef = { type: String, ref: 'User', required: true };
    const result = zodToMongoose(z.object({ name: z.string() }), { dbFields: { user: userRef } });
    expect(result.user).toBe(userRef);
    expect(result.name).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// subdocSchemas config
// ---------------------------------------------------------------------------

describe('zodToMongoose — subdocSchemas config', () => {
  it('wraps the subdoc schema in an array', () => {
    const fakeSubSchema = { fake: true } as any;
    const result = zodToMongoose(z.object({ items: z.array(z.string()) }), {
      subdocSchemas: { items: fakeSubSchema },
    });
    expect(result.items).toEqual([fakeSubSchema]);
  });
});
