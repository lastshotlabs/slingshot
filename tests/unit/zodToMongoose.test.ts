/**
 * Tests for src/framework/lib/zodToMongoose.ts
 * Lines: 8-20, 25, 30-38, 68-105
 *
 * We mock @lib/mongo to avoid a real mongoose dependency.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
const actualMongo = await import('@lib/mongo');

// Mock the mongo module so getMongooseModule returns a mongoose-like object
// with a Schema class and Schema.Types.Mixed / Schema.Types.ObjectId
mock.module('@lib/mongo', () => {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class MockSchema {
    static Types = {
      Mixed: 'Mixed',
      ObjectId: 'ObjectId',
    };
  }
  return {
    ...actualMongo,
    getMongooseModule: () => ({ Schema: MockSchema }),
  };
});

afterAll(() => {
  mock.restore();
});

// Import AFTER mock
import { zodToMongoose } from '../../src/framework/lib/zodToMongoose';

describe('zodToMongoose — basic field type conversion', () => {
  test('converts ZodString to { type: String }', () => {
    const schema = z.object({ name: z.string() });
    const result = zodToMongoose(schema);

    expect(result.name).toEqual({ type: String, required: true });
  });

  test('converts ZodNumber to { type: Number }', () => {
    const schema = z.object({ count: z.number() });
    const result = zodToMongoose(schema);

    expect(result.count).toEqual({ type: Number, required: true });
  });

  test('converts ZodBoolean to { type: Boolean }', () => {
    const schema = z.object({ active: z.boolean() });
    const result = zodToMongoose(schema);

    expect(result.active).toEqual({ type: Boolean, required: true });
  });

  test('converts ZodDate to { type: Date }', () => {
    const schema = z.object({ createdAt: z.date() });
    const result = zodToMongoose(schema);

    expect(result.createdAt).toEqual({ type: Date, required: true });
  });

  test('converts ZodEnum to { type: String, enum: [...] }', () => {
    const schema = z.object({ status: z.enum(['active', 'inactive', 'pending']) });
    const result = zodToMongoose(schema);

    expect(result.status).toEqual({
      type: String,
      enum: ['active', 'inactive', 'pending'],
      required: true,
    });
  });

  test('unknown Zod type maps to Mixed', () => {
    const schema = z.object({ data: z.record(z.unknown()) });
    const result = zodToMongoose(schema);

    expect((result.data as any).type).toBe('Mixed');
  });

  test('excludes the id field automatically', () => {
    const schema = z.object({ id: z.string(), name: z.string() });
    const result = zodToMongoose(schema);

    expect(result.id).toBeUndefined();
    expect(result.name).toBeDefined();
  });
});

describe('zodToMongoose — optional and nullable fields', () => {
  test('ZodOptional marks field as required: false', () => {
    const schema = z.object({ bio: z.string().optional() });
    const result = zodToMongoose(schema);

    expect(result.bio).toEqual({ type: String, required: false });
  });

  test('ZodNullable marks field as required: false', () => {
    const schema = z.object({ bio: z.string().nullable() });
    const result = zodToMongoose(schema);

    expect(result.bio).toEqual({ type: String, required: false });
  });

  test('ZodDefault marks field as required: false', () => {
    const schema = z.object({ count: z.number().default(0) });
    const result = zodToMongoose(schema);

    expect(result.count).toEqual({ type: Number, required: false });
  });

  test('nested optional nullable string', () => {
    const schema = z.object({ name: z.string().optional().nullable() });
    const result = zodToMongoose(schema);

    expect(result.name).toEqual({ type: String, required: false });
  });
});

describe('zodToMongoose — config options', () => {
  test('refs map API field to ObjectId reference', () => {
    const schema = z.object({ userId: z.string(), title: z.string() });
    const result = zodToMongoose(schema, {
      refs: {
        userId: { dbField: 'user', ref: 'User' },
      },
    });

    expect(result.user).toEqual({ type: 'ObjectId', ref: 'User', required: true });
    expect(result.userId).toBeUndefined(); // replaced by ref
  });

  test('typeOverrides replace auto-converted types', () => {
    const schema = z.object({ price: z.number(), tags: z.array(z.string()) });
    const result = zodToMongoose(schema, {
      typeOverrides: {
        price: { type: Number, required: true, min: 0 },
      },
    });

    expect(result.price).toEqual({ type: Number, required: true, min: 0 });
  });

  test('subdocSchemas wraps field in array', () => {
    const fakeSubSchema = { path: 'fake-schema' } as any;
    const schema = z.object({ items: z.array(z.string()) });
    const result = zodToMongoose(schema, {
      subdocSchemas: { items: fakeSubSchema },
    });

    expect(result.items).toEqual([fakeSubSchema]);
  });

  test('dbFields are merged into the output', () => {
    const schema = z.object({ name: z.string() });
    const result = zodToMongoose(schema, {
      dbFields: {
        createdBy: { type: 'ObjectId', ref: 'User' },
        __v: { type: Number, default: 0 },
      },
    });

    expect(result.createdBy).toEqual({ type: 'ObjectId', ref: 'User' });
    expect(result.__v).toEqual({ type: Number, default: 0 });
  });

  test('empty schema with no options returns empty object', () => {
    const schema = z.object({});
    const result = zodToMongoose(schema);

    expect(result).toEqual({});
  });

  test('all config options combined', () => {
    const schema = z.object({
      id: z.string(),
      title: z.string(),
      ownerId: z.string(),
      status: z.enum(['draft', 'published']).optional(),
    });

    const result = zodToMongoose(schema, {
      refs: { ownerId: { dbField: 'owner', ref: 'User' } },
      typeOverrides: { title: { type: String, required: true, maxlength: 100 } },
      dbFields: { _tenant: { type: 'ObjectId', ref: 'Tenant' } },
    });

    expect(result.id).toBeUndefined();
    expect(result.owner).toEqual({ type: 'ObjectId', ref: 'User', required: true });
    expect(result.ownerId).toBeUndefined();
    expect(result.title).toEqual({ type: String, required: true, maxlength: 100 });
    expect(result.status).toEqual({ type: String, enum: ['draft', 'published'], required: false });
    expect(result._tenant).toEqual({ type: 'ObjectId', ref: 'Tenant' });
  });
});
