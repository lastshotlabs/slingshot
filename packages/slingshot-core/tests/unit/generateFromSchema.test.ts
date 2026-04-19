import { describe, expect, it } from 'bun:test';
import { faker as fakerInstance } from '@faker-js/faker';
import { z } from 'zod';
import { generateFromSchema, generateMany, generateExample } from '../../src/faker';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('generateFromSchema — primitives', () => {
  it('generates a string', () => {
    const result = generateFromSchema<string>(z.string(), { seed: 1 });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('generates a number', () => {
    const result = generateFromSchema<number>(z.number(), { seed: 1 });
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });

  it('generates an integer', () => {
    const result = generateFromSchema<number>(z.number().int(), { seed: 1 });
    expect(Number.isInteger(result)).toBe(true);
  });

  it('generates a boolean', () => {
    const result = generateFromSchema<boolean>(z.boolean(), { seed: 1 });
    expect(typeof result).toBe('boolean');
  });

  it('generates a date', () => {
    const result = generateFromSchema<Date>(z.date(), { seed: 1 });
    expect(result).toBeInstanceOf(Date);
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  it('generates null for z.null()', () => {
    const result = generateFromSchema(z.null(), { seed: 1 });
    expect(result).toBeNull();
  });

  it('generates undefined for z.undefined()', () => {
    const result = generateFromSchema(z.undefined(), { seed: 1 });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// String formats
// ---------------------------------------------------------------------------

describe('generateFromSchema — string formats', () => {
  it('generates a valid email', () => {
    const result = generateFromSchema<string>(z.string().email(), { seed: 1 });
    expect(result).toContain('@');
  });

  it('generates a valid UUID', () => {
    const result = generateFromSchema<string>(z.string().uuid(), { seed: 1 });
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates a valid URL', () => {
    const result = generateFromSchema<string>(z.string().url(), { seed: 1 });
    expect(result).toMatch(/^https?:\/\//);
  });

  it('generates an IPv4 address', () => {
    const result = generateFromSchema<string>(z.ipv4(), { seed: 1 });
    expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it('generates a datetime ISO string', () => {
    const result = generateFromSchema<string>(z.string().datetime(), { seed: 1 });
    expect(new Date(result).toISOString()).toBe(result);
  });

  it('generates a date string', () => {
    const result = generateFromSchema<string>(z.string().date(), { seed: 1 });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// String constraints
// ---------------------------------------------------------------------------

describe('generateFromSchema — string constraints', () => {
  it('respects min length', () => {
    const result = generateFromSchema<string>(z.string().min(10), { seed: 1 });
    expect(result.length).toBeGreaterThanOrEqual(10);
  });

  it('respects max length', () => {
    const result = generateFromSchema<string>(z.string().max(5), { seed: 1 });
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Number constraints
// ---------------------------------------------------------------------------

describe('generateFromSchema — number constraints', () => {
  it('respects min value', () => {
    const schema = z.number().min(100);
    const result = generateFromSchema<number>(schema, { seed: 1 });
    expect(result).toBeGreaterThanOrEqual(100);
  });

  it('respects max value', () => {
    const schema = z.number().max(10);
    const result = generateFromSchema<number>(schema, { seed: 1 });
    expect(result).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Enums and literals
// ---------------------------------------------------------------------------

describe('generateFromSchema — enums & literals', () => {
  it('picks from enum values', () => {
    const schema = z.enum(['active', 'suspended', 'deleted']);
    const result = generateFromSchema<string>(schema, { seed: 1 });
    expect(['active', 'suspended', 'deleted']).toContain(result);
  });

  it('returns literal value', () => {
    const schema = z.literal('hello');
    const result = generateFromSchema<string>(schema, { seed: 1 });
    expect(result).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

describe('generateFromSchema — objects', () => {
  it('generates a valid object with typed fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int().min(0).max(120),
      email: z.string().email(),
      role: z.enum(['admin', 'member']),
    });

    const result = generateFromSchema<{
      name: string;
      age: number;
      email: string;
      role: string;
    }>(schema, { seed: 42 });

    expect(typeof result.name).toBe('string');
    expect(Number.isInteger(result.age)).toBe(true);
    expect(result.age).toBeGreaterThanOrEqual(0);
    expect(result.age).toBeLessThanOrEqual(120);
    expect(result.email).toContain('@');
    expect(['admin', 'member']).toContain(result.role);
  });

  it('includes optional fields based on optionalRate', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
    });

    // With 100% rate, optional field should always be present
    const result = generateFromSchema<{ name: string; bio?: string }>(schema, {
      seed: 42,
      optionalRate: 1.0,
    });
    expect(result).toHaveProperty('bio');
  });

  it('excludes optional fields based on optionalRate', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
    });

    // With 0% rate, optional field should never be present
    const result = generateFromSchema<{ name: string; bio?: string }>(schema, {
      seed: 42,
      optionalRate: 0,
    });
    expect(result).not.toHaveProperty('bio');
  });
});

// ---------------------------------------------------------------------------
// Nested objects
// ---------------------------------------------------------------------------

describe('generateFromSchema — nesting', () => {
  it('handles nested objects', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        address: z.object({
          city: z.string(),
        }),
      }),
    });

    const result = generateFromSchema<{ user: { name: string; address: { city: string } } }>(
      schema,
      { seed: 42 },
    );
    expect(typeof result.user.name).toBe('string');
    expect(typeof result.user.address.city).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe('generateFromSchema — arrays', () => {
  it('generates an array of items', () => {
    const schema = z.array(z.string());
    const result = generateFromSchema<string[]>(schema, { seed: 1 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const item of result) {
      expect(typeof item).toBe('string');
    }
  });

  it('respects min/max array size', () => {
    const schema = z.array(z.number()).min(2).max(4);
    const result = generateFromSchema<number[]>(schema, { seed: 1 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

describe('generateFromSchema — unions', () => {
  it('picks one branch of a union', () => {
    const schema = z.union([z.string(), z.number()]);
    const result = generateFromSchema(schema, { seed: 1 });
    expect(typeof result === 'string' || typeof result === 'number').toBe(true);
  });

  it('handles discriminated unions', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), content: z.string() }),
      z.object({ kind: z.literal('image'), url: z.string().url() }),
    ]);
    const result = generateFromSchema<{ kind: string }>(schema, { seed: 1 });
    expect(['text', 'image']).toContain(result.kind);
  });
});

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

describe('generateFromSchema — wrappers', () => {
  it('handles nullable (sometimes null)', () => {
    // Generate many and check that at least some are non-null and type is correct
    const schema = z.string().nullable();
    const results = generateMany<string | null>(schema, 50, { seed: 42 });
    const nonNull = results.filter((r) => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    for (const r of nonNull) {
      expect(typeof r).toBe('string');
    }
  });

  it('handles defaults by generating the inner type', () => {
    const schema = z.string().default('fallback');
    const result = generateFromSchema<string>(schema, { seed: 1 });
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe('generateFromSchema — overrides', () => {
  it('applies top-level overrides', () => {
    const schema = z.object({
      name: z.string(),
      role: z.enum(['admin', 'member']),
    });

    const result = generateFromSchema<{ name: string; role: string }>(schema, {
      seed: 42,
      overrides: { role: 'admin' },
    });
    expect(result.role).toBe('admin');
  });

  it('applies nested overrides via dot notation', () => {
    const schema = z.object({
      user: z.object({
        city: z.string(),
      }),
    });

    const result = generateFromSchema<{ user: { city: string } }>(schema, {
      seed: 42,
      overrides: { 'user.city': 'Portland' },
    });
    expect(result.user.city).toBe('Portland');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('generateFromSchema — determinism', () => {
  it('produces identical output for the same seed', () => {
    const schema = z.object({
      name: z.string(),
      email: z.string().email(),
      count: z.number().int(),
    });

    const a = generateFromSchema(schema, { seed: 42 });
    const b = generateFromSchema(schema, { seed: 42 });
    expect(a).toEqual(b);
  });

  it('seeds a custom faker instance when both faker and seed are provided', () => {
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    // Pass a custom faker instance WITH a seed — exercises lines 74-75
    const a = generateFromSchema(schema, { faker: fakerInstance, seed: 99 });
    const b = generateFromSchema(schema, { faker: fakerInstance, seed: 99 });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// generateMany
// ---------------------------------------------------------------------------

describe('generateMany', () => {
  it('generates the requested number of records', () => {
    const schema = z.object({ id: z.string().uuid() });
    const results = generateMany(schema, 15, { seed: 1 });
    expect(results).toHaveLength(15);
  });
});

// ---------------------------------------------------------------------------
// generateExample
// ---------------------------------------------------------------------------

describe('generateExample', () => {
  it('produces JSON-clean output with all fields present', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
    });

    const result = generateExample<{ name: string; bio: string }>(schema);
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('bio');
    // Should be serializable
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('is deterministic across calls', () => {
    const schema = z.object({ value: z.number() });
    expect(generateExample(schema)).toEqual(generateExample(schema));
  });
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

describe('generateFromSchema — records', () => {
  it('generates a record with string keys and typed values', () => {
    const schema = z.record(z.string(), z.number());
    const result = generateFromSchema<Record<string, number>>(schema, { seed: 1 });
    expect(typeof result).toBe('object');
    for (const [key, val] of Object.entries(result)) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Tuples
// ---------------------------------------------------------------------------

describe('generateFromSchema — tuples', () => {
  it('generates a typed tuple', () => {
    const schema = z.tuple([z.string(), z.number(), z.boolean()]);
    const result = generateFromSchema<[string, number, boolean]>(schema, { seed: 1 });
    expect(Array.isArray(result)).toBe(true);
    expect(typeof result[0]).toBe('string');
    expect(typeof result[1]).toBe('number');
    expect(typeof result[2]).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------

describe('generateFromSchema — intersections', () => {
  it('merges two object schemas', () => {
    const schema = z.intersection(
      z.object({ name: z.string() }),
      z.object({ age: z.number() }),
    );
    const result = generateFromSchema<{ name: string; age: number }>(schema, { seed: 1 });
    expect(typeof result.name).toBe('string');
    expect(typeof result.age).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Lazy (recursive)
// ---------------------------------------------------------------------------

describe('generateFromSchema — lazy', () => {
  it('handles recursive schemas up to maxDepth', () => {
    type Tree = { value: string; children: Tree[] | null };
    const treeSchema: z.ZodType<Tree> = z.object({
      value: z.string(),
      children: z.lazy(() => z.array(treeSchema)).nullable(),
    });

    const result = generateFromSchema<Tree>(treeSchema, { seed: 42, maxDepth: 2 });
    expect(typeof result.value).toBe('string');
    // Should not throw due to infinite recursion
  });
});

// ---------------------------------------------------------------------------
// Coerce
// ---------------------------------------------------------------------------

describe('generateFromSchema — coerce', () => {
  it('generates a value for z.coerce.date()', () => {
    const schema = z.coerce.date();
    const result = generateFromSchema<Date>(schema, { seed: 1 });
    expect(result).toBeInstanceOf(Date);
  });

  it('generates a value for z.coerce.number()', () => {
    const schema = z.coerce.number();
    const result = generateFromSchema<number>(schema, { seed: 1 });
    expect(typeof result).toBe('number');
  });
});
