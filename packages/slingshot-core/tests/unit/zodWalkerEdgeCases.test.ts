/**
 * Edge-case and regression tests for the Zod walker.
 *
 * These target specific bugs found during audit:
 * - Double optional roll
 * - Exclusive float bounds
 * - Integer format detection
 * - Deeply nested schemas
 * - Generated data actually validates against source schema
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { generateFromSchema, generateMany, generateExample, walkSchema } from '../../src/faker';

// ---------------------------------------------------------------------------
// Bug regression: double optional roll
// ---------------------------------------------------------------------------

describe('optional field probability (no double-roll)', () => {
  it('optional fields appear at the expected rate', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
    });

    // Generate 200 records with optionalRate = 0.7
    // Expected: ~70% have bio. If double-roll bug exists, it'd be ~49%.
    const results = generateMany<{ name: string; bio?: string }>(schema, 200, {
      seed: 99,
      optionalRate: 0.7,
    });

    const withBio = results.filter((r) => r.bio !== undefined && 'bio' in r).length;
    const rate = withBio / results.length;

    // Accept 55%–85% range (70% target ± reasonable variance for 200 samples)
    expect(rate).toBeGreaterThan(0.55);
    expect(rate).toBeLessThan(0.85);
  });

  it('optional fields at rate 1.0 are always present with a value', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
    });

    const results = generateMany<{ name: string; bio?: string }>(schema, 50, {
      seed: 1,
      optionalRate: 1.0,
    });

    for (const r of results) {
      expect(r).toHaveProperty('bio');
      // Should be a string, NOT undefined (the old double-roll would produce
      // undefined ~30% of the time even at rate 1.0 in the object handler
      // because the optional handler would roll again)
      expect(typeof r.bio).toBe('string');
    }
  });

  it('optional fields at rate 0 are never present', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
      age: z.number().optional(),
    });

    const results = generateMany<{ name: string; bio?: string; age?: number }>(schema, 50, {
      seed: 1,
      optionalRate: 0,
    });

    for (const r of results) {
      expect(r).not.toHaveProperty('bio');
      expect(r).not.toHaveProperty('age');
      expect(r).toHaveProperty('name');
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: double optional roll with non-standard wrapper ordering
// ---------------------------------------------------------------------------

describe('optional wrapper ordering', () => {
  it('.optional().nullable() chain respects optionalRate', () => {
    // This tests the case where optional is NOT the outermost wrapper.
    // z.string().optional().nullable() is nullable(optional(string)).
    // The object handler detects the nested optional and rolls once;
    // _optionalDecided prevents the optional handler from rolling again.
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional().nullable(),
    });

    const results = generateMany<{ name: string; bio?: string | null }>(schema, 200, {
      seed: 88,
      optionalRate: 1.0,
    });

    // At rate 1.0, bio should always be present (not skipped).
    // It may be null (~10% chance from nullable), but the key must exist.
    for (const r of results) {
      expect(r).toHaveProperty('name');
      // With rate 1.0 and _optionalDecided, the field should always be present
      expect('bio' in r).toBe(true);
    }
  });

  it('.nullable().optional() chain respects optionalRate', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().nullable().optional(),
    });

    const results = generateMany<{ name: string; bio?: string | null }>(schema, 200, {
      seed: 88,
      optionalRate: 1.0,
    });

    for (const r of results) {
      expect('bio' in r).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: nested overrides with optional parent
// ---------------------------------------------------------------------------

describe('nested overrides with optional parent', () => {
  it('override on nested field forces optional parent to be present', () => {
    const schema = z.object({
      address: z.object({
        city: z.string(),
        zip: z.string(),
      }).optional(),
    });

    const result = generateFromSchema<{ address?: { city: string; zip: string } }>(schema, {
      seed: 1,
      optionalRate: 0, // would normally skip the optional field
      overrides: { 'address.city': 'Portland' },
    });

    // The address object must be present because we have a nested override
    expect(result.address).toBeDefined();
    expect(result.address!.city).toBe('Portland');
  });
});

// ---------------------------------------------------------------------------
// Bug regression: cuid format
// ---------------------------------------------------------------------------

describe('cuid format', () => {
  it('generates a string starting with "c"', () => {
    const schema = z.string().cuid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      expect(r[0]).toBe('c');
      expect(r.length).toBe(25);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: seeded batches produce distinct records
// ---------------------------------------------------------------------------

describe('seeded generateMany distinctness', () => {
  it('seeded batch produces distinct records (not all identical)', () => {
    const schema = z.object({
      name: z.string(),
      email: z.string().email(),
      score: z.number().int().min(0).max(1000),
    });

    // With a seed, records should still be distinct — the seed initializes
    // the PRNG once, and subsequent calls advance the state.
    const results = generateMany<{ name: string; email: string; score: number }>(
      schema, 20, { seed: 42 },
    );

    const emails = new Set(results.map((r) => r.email));
    // All 20 should be unique (or nearly — at minimum more than half)
    expect(emails.size).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Bug regression: exclusive float bounds
// ---------------------------------------------------------------------------

describe('exclusive number bounds', () => {
  it('z.number().gt(5) produces values > 5 (not >= 6)', () => {
    const schema = z.number().gt(5);
    const results = generateMany<number>(schema, 100, { seed: 42 });
    for (const r of results) {
      expect(r).toBeGreaterThan(5);
    }
  });

  it('z.number().lt(5) produces values < 5 (not <= 4)', () => {
    const schema = z.number().lt(5);
    const results = generateMany<number>(schema, 100, { seed: 42 });
    for (const r of results) {
      expect(r).toBeLessThan(5);
    }
  });

  it('z.number().gt(0).lt(1) produces values in (0, 1)', () => {
    const schema = z.number().gt(0).lt(1);
    const results = generateMany<number>(schema, 100, { seed: 42 });
    for (const r of results) {
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('z.number().gte(0).lte(100) produces values in [0, 100]', () => {
    const schema = z.number().gte(0).lte(100);
    const results = generateMany<number>(schema, 100, { seed: 42 });
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(100);
    }
  });

  it('z.number().int().min(1).max(10) produces integers in [1, 10]', () => {
    const schema = z.number().int().min(1).max(10);
    const results = generateMany<number>(schema, 200, { seed: 42 });
    for (const r of results) {
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(10);
    }
  });

  it('z.number().positive() produces values > 0', () => {
    const schema = z.number().positive();
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(r).toBeGreaterThan(0);
    }
  });

  it('z.number().negative() produces values < 0', () => {
    const schema = z.number().negative();
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(r).toBeLessThan(0);
    }
  });

  it('z.number().nonnegative() produces values >= 0', () => {
    const schema = z.number().nonnegative();
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation roundtrip: generated data parses against source schema
// ---------------------------------------------------------------------------

describe('validation roundtrip', () => {
  it('simple object passes validation', () => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      age: z.number().int().min(0).max(150),
      role: z.enum(['admin', 'member', 'guest']),
      active: z.boolean(),
    });

    const results = generateMany(schema, 50, { seed: 42, optionalRate: 1.0 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `Validation failed: ${JSON.stringify(parsed.error.issues)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });

  it('nested object passes validation', () => {
    const addressSchema = z.object({
      street: z.string().min(1),
      city: z.string().min(1),
      zip: z.string().min(1),
    });

    const schema = z.object({
      name: z.string().min(1),
      address: addressSchema,
    });

    const results = generateMany(schema, 20, { seed: 42 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `Validation failed: ${JSON.stringify(parsed.error.issues)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });

  it('enum-only object passes validation', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive', 'pending']),
      priority: z.enum(['low', 'medium', 'high', 'critical']),
    });

    const results = generateMany(schema, 100, { seed: 42 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('array of objects passes validation', () => {
    const itemSchema = z.object({
      id: z.string().uuid(),
      value: z.number().min(0),
    });
    const schema = z.array(itemSchema).min(1).max(5);

    const results = generateMany(schema, 20, { seed: 42 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `Validation failed: ${JSON.stringify(parsed.error.issues)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });

  it('schema with all optional fields passes validation', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().optional(),
      c: z.boolean().optional(),
    });

    const results = generateMany(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('nullable fields pass validation', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().nullable(),
    });

    const results = generateMany(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('union schema passes validation', () => {
    const schema = z.union([
      z.object({ type: z.literal('text'), content: z.string() }),
      z.object({ type: z.literal('number'), value: z.number() }),
    ]);

    const results = generateMany(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('schema with defaults passes validation', () => {
    const schema = z.object({
      name: z.string(),
      role: z.string().default('member'),
      count: z.number().default(0),
    });

    const results = generateMany(schema, 20, { seed: 42 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// String format edge cases
// ---------------------------------------------------------------------------

describe('string format validation roundtrip', () => {
  it('uuid validates', () => {
    const schema = z.string().uuid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('email validates', () => {
    const schema = z.string().email();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('url validates', () => {
    const schema = z.string().url();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      expect(schema.safeParse(r).success).toBe(true);
    }
  });

  it('datetime validates', () => {
    const schema = z.string().datetime();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`datetime validation failed for: "${r}"`);
      }
    }
  });

  it('date validates', () => {
    const schema = z.string().date();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`date validation failed for: "${r}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Complex / deeply nested schemas
// ---------------------------------------------------------------------------

describe('complex schemas', () => {
  it('handles 4 levels of nesting', () => {
    const schema = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.string(),
          }),
        }),
      }),
    });

    const result = generateFromSchema<{
      a: { b: { c: { d: string } } };
    }>(schema, { seed: 1 });
    expect(typeof result.a.b.c.d).toBe('string');
  });

  it('handles mixed array + object nesting', () => {
    const schema = z.object({
      users: z.array(
        z.object({
          name: z.string(),
          tags: z.array(z.string()),
        }),
      ),
    });

    const result = generateFromSchema<{
      users: Array<{ name: string; tags: string[] }>;
    }>(schema, { seed: 1 });
    expect(Array.isArray(result.users)).toBe(true);
    for (const user of result.users) {
      expect(typeof user.name).toBe('string');
      expect(Array.isArray(user.tags)).toBe(true);
    }
  });

  it('handles objects with many fields', () => {
    const schema = z.object({
      f1: z.string(),
      f2: z.string(),
      f3: z.number(),
      f4: z.boolean(),
      f5: z.string().email(),
      f6: z.string().uuid(),
      f7: z.enum(['a', 'b', 'c']),
      f8: z.number().int().min(0).max(100),
      f9: z.string().url(),
      f10: z.date(),
    });

    const result = generateFromSchema<Record<string, unknown>>(schema, { seed: 42 });
    expect(Object.keys(result)).toHaveLength(10);
  });

  it('handles empty object', () => {
    const schema = z.object({});
    const result = generateFromSchema<Record<string, never>>(schema, { seed: 1 });
    expect(result).toEqual({});
  });

  it('handles z.unknown()', () => {
    const schema = z.unknown();
    const result = generateFromSchema(schema, { seed: 1 });
    expect(result).toBeDefined();
  });

  it('handles z.any()', () => {
    const schema = z.any();
    const result = generateFromSchema(schema, { seed: 1 });
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Override edge cases
// ---------------------------------------------------------------------------

describe('override edge cases', () => {
  it('override with null value', () => {
    const schema = z.object({
      name: z.string(),
      note: z.string().nullable(),
    });

    const result = generateFromSchema<{ name: string; note: string | null }>(schema, {
      seed: 1,
      overrides: { note: null },
    });
    expect(result.note).toBeNull();
  });

  it('override with 0 value', () => {
    const schema = z.object({
      count: z.number(),
    });

    const result = generateFromSchema<{ count: number }>(schema, {
      seed: 1,
      overrides: { count: 0 },
    });
    expect(result.count).toBe(0);
  });

  it('override with empty string', () => {
    const schema = z.object({
      name: z.string(),
    });

    const result = generateFromSchema<{ name: string }>(schema, {
      seed: 1,
      overrides: { name: '' },
    });
    expect(result.name).toBe('');
  });

  it('override with false value', () => {
    const schema = z.object({
      active: z.boolean(),
    });

    const result = generateFromSchema<{ active: boolean }>(schema, {
      seed: 1,
      overrides: { active: false },
    });
    expect(result.active).toBe(false);
  });

  it('override forces optional field to be present', () => {
    const schema = z.object({
      name: z.string(),
      bio: z.string().optional(),
    });

    const result = generateFromSchema<{ name: string; bio?: string }>(schema, {
      seed: 1,
      optionalRate: 0,
      overrides: { bio: 'forced bio' },
    });
    expect(result.bio).toBe('forced bio');
  });

  it('multiple nested overrides', () => {
    const schema = z.object({
      a: z.object({
        x: z.string(),
        y: z.number(),
      }),
      b: z.string(),
    });

    const result = generateFromSchema<{ a: { x: string; y: number }; b: string }>(schema, {
      seed: 1,
      overrides: { 'a.x': 'overridden', 'a.y': 42, b: 'also overridden' },
    });
    expect(result.a.x).toBe('overridden');
    expect(result.a.y).toBe(42);
    expect(result.b).toBe('also overridden');
  });
});

// ---------------------------------------------------------------------------
// generateMany uniqueness
// ---------------------------------------------------------------------------

describe('generateMany diversity', () => {
  it('produces distinct records (not all identical)', () => {
    const schema = z.object({
      name: z.string(),
      email: z.string().email(),
    });

    // Without a seed, records should be diverse
    const results = generateMany<{ name: string; email: string }>(schema, 20);
    const emails = new Set(results.map((r) => r.email));

    // At least half should be unique
    expect(emails.size).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Realistic entity-like schema roundtrip
// ---------------------------------------------------------------------------

describe('entity-like schema roundtrip', () => {
  it('User entity schema validates', () => {
    const createUserSchema = z.object({
      name: z.string().min(1).max(256),
      email: z.string().email(),
      role: z.enum(['admin', 'member', 'guest']),
      bio: z.string().max(1000).optional(),
      active: z.boolean(),
    });

    const results = generateMany(createUserSchema, 100, { seed: 42, optionalRate: 1.0 });
    for (const r of results) {
      const parsed = createUserSchema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `User validation failed:\n${JSON.stringify(parsed.error.issues, null, 2)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });

  it('Post entity schema with FK validates', () => {
    const createPostSchema = z.object({
      title: z.string().min(1).max(500),
      body: z.string().min(1),
      authorId: z.string().uuid(),
      status: z.enum(['draft', 'published', 'archived']),
      tags: z.array(z.string()).max(10).optional(),
    });

    const results = generateMany(createPostSchema, 50, { seed: 42, optionalRate: 1.0 });
    for (const r of results) {
      const parsed = createPostSchema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `Post validation failed:\n${JSON.stringify(parsed.error.issues, null, 2)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });

  it('Message entity schema validates', () => {
    const createMessageSchema = z.object({
      content: z.string().min(1),
      channelId: z.string().uuid(),
      authorId: z.string().uuid(),
      parentId: z.string().uuid().nullable().optional(),
    });

    const results = generateMany(createMessageSchema, 50, { seed: 42, optionalRate: 1.0 });
    for (const r of results) {
      const parsed = createMessageSchema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `Message validation failed:\n${JSON.stringify(parsed.error.issues, null, 2)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: z.int() must produce integers
// ---------------------------------------------------------------------------

describe('z.int() handling', () => {
  it('z.int() produces integers that pass validation', () => {
    const schema = z.int();
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(Number.isInteger(r)).toBe(true);
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`z.int() validation failed for: ${r}`);
      }
    }
  });

  it('z.int() in an object produces integers', () => {
    const schema = z.object({
      count: z.int(),
      name: z.string(),
    });

    const results = generateMany<{ count: number; name: string }>(schema, 50, { seed: 1 });
    for (const r of results) {
      expect(Number.isInteger(r.count)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: array constraints (min/max/length)
// ---------------------------------------------------------------------------

describe('array constraints', () => {
  it('z.array().min(5) produces at least 5 elements', () => {
    const schema = z.array(z.string()).min(5);
    const results = generateMany<string[]>(schema, 20, { seed: 42 });
    for (const r of results) {
      expect(r.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('z.array().max(2) produces at most 2 elements', () => {
    const schema = z.array(z.string()).max(2);
    const results = generateMany<string[]>(schema, 20, { seed: 42 });
    for (const r of results) {
      expect(r.length).toBeLessThanOrEqual(2);
    }
  });

  it('z.array().length(3) produces exactly 3 elements', () => {
    const schema = z.array(z.number()).length(3);
    const results = generateMany<number[]>(schema, 20, { seed: 42 });
    for (const r of results) {
      expect(r.length).toBe(3);
    }
  });

  it('z.array().min(3).max(5) produces 3-5 elements', () => {
    const schema = z.array(z.string()).min(3).max(5);
    const results = generateMany<string[]>(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(r.length).toBeGreaterThanOrEqual(3);
      expect(r.length).toBeLessThanOrEqual(5);
    }
  });

  it('array constraints pass validation roundtrip', () => {
    const schema = z.array(z.string().min(1)).min(2).max(4);
    const results = generateMany(schema, 50, { seed: 42 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(
          `Array validation failed: ${JSON.stringify(parsed.error.issues)}\nInput: ${JSON.stringify(r)}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: ID format validation roundtrips
// ---------------------------------------------------------------------------

describe('ID format validation roundtrip', () => {
  it('cuid validates', () => {
    const schema = z.string().cuid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`cuid validation failed for: "${r}"`);
      }
    }
  });

  it('cuid2 validates', () => {
    const schema = z.string().cuid2();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`cuid2 validation failed for: "${r}"`);
      }
    }
  });

  it('ulid validates', () => {
    const schema = z.string().ulid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`ulid validation failed for: "${r}"`);
      }
    }
  });

  it('time validates', () => {
    const schema = z.string().time();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`time validation failed for: "${r}"`);
      }
    }
  });

  it('nanoid validates', () => {
    const schema = z.string().nanoid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`nanoid validation failed for: "${r}"`);
      }
    }
  });

  it('xid validates', () => {
    const schema = z.string().xid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`xid validation failed for: "${r}"`);
      }
    }
  });

  it('ksuid validates', () => {
    const schema = z.string().ksuid();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`ksuid validation failed for: "${r}"`);
      }
    }
  });

  it('base64 validates', () => {
    const schema = z.string().base64();
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`base64 validation failed for: "${r}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: number multipleOf
// ---------------------------------------------------------------------------

describe('number multipleOf', () => {
  it('z.number().multipleOf(0.5) produces valid multiples', () => {
    const schema = z.number().multipleOf(0.5);
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`multipleOf(0.5) validation failed for: ${r}`);
      }
    }
  });

  it('z.number().multipleOf(3) produces valid multiples', () => {
    const schema = z.number().multipleOf(3);
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      expect(r % 3).toBe(0);
    }
  });

  it('z.number().multipleOf(0.25).min(0).max(10) stays in range', () => {
    const schema = z.number().multipleOf(0.25).min(0).max(10);
    const results = generateMany<number>(schema, 50, { seed: 42 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`multipleOf(0.25) + range validation failed for: ${r}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bug regression: string startsWith / endsWith / includes
// ---------------------------------------------------------------------------

describe('string constraint formats', () => {
  it('z.string().startsWith("pre") produces valid strings', () => {
    const schema = z.string().startsWith('pre');
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`startsWith validation failed for: "${r}"`);
      }
    }
  });

  it('z.string().endsWith("suf") produces valid strings', () => {
    const schema = z.string().endsWith('suf');
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`endsWith validation failed for: "${r}"`);
      }
    }
  });

  it('z.string().includes("needle") produces valid strings', () => {
    const schema = z.string().includes('needle');
    const results = generateMany<string>(schema, 20, { seed: 1 });
    for (const r of results) {
      const parsed = schema.safeParse(r);
      if (!parsed.success) {
        throw new Error(`includes validation failed for: "${r}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Stress: high volume
// ---------------------------------------------------------------------------

describe('high volume generation', () => {
  it('generates 1000 records without errors', () => {
    const schema = z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      email: z.string().email(),
      score: z.number().int().min(0).max(100),
      status: z.enum(['active', 'inactive']),
    });

    const results = generateMany(schema, 1000, { seed: 42 });
    expect(results).toHaveLength(1000);

    // Spot check validation on a sample
    for (let i = 0; i < 100; i++) {
      expect(schema.safeParse(results[i]).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Set constraints
// ---------------------------------------------------------------------------

describe('set constraints', () => {
  it('respects min size constraint', () => {
    const schema = z.set(z.string()).min(5);
    for (let i = 0; i < 20; i++) {
      const result = walkSchema(schema as any, { seed: i }) as Set<string>;
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBeGreaterThanOrEqual(5);
    }
  });

  it('respects max size constraint', () => {
    const schema = z.set(z.number()).max(2);
    for (let i = 0; i < 20; i++) {
      const result = walkSchema(schema as any, { seed: i }) as Set<number>;
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBeLessThanOrEqual(2);
    }
  });

  it('respects exact size constraint', () => {
    const schema = z.set(z.string()).size(4);
    for (let i = 0; i < 20; i++) {
      const result = walkSchema(schema as any, { seed: i }) as Set<string>;
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(4);
    }
  });

  it('respects min + max range constraint', () => {
    const schema = z.set(z.string()).min(3).max(6);
    for (let i = 0; i < 20; i++) {
      const result = walkSchema(schema as any, { seed: i }) as Set<string>;
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBeGreaterThanOrEqual(3);
      expect(result.size).toBeLessThanOrEqual(6);
    }
  });

  it('generated set validates against schema', () => {
    const schema = z.set(z.string().min(1)).min(2).max(5);
    for (let i = 0; i < 20; i++) {
      const result = walkSchema(schema as any, { seed: i });
      expect(schema.safeParse(result).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint interactions (multipleOf + int, combined string constraints)
// ---------------------------------------------------------------------------

describe('number: int + multipleOf interaction', () => {
  it('z.number().int().multipleOf(3) produces integer multiples of 3', () => {
    const schema = z.number().int().multipleOf(3);
    for (let i = 0; i < 50; i++) {
      const val = generateFromSchema(schema as any, { seed: i }) as number;
      expect(Number.isInteger(val)).toBe(true);
      expect(val % 3).toBe(0);
    }
  });

  it('z.number().int().multipleOf(7).gt(10).lt(50) passes validation', () => {
    const schema = z.number().int().multipleOf(7).gt(10).lt(50);
    for (let i = 0; i < 50; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('z.number().multipleOf(0.5).positive() passes validation', () => {
    const schema = z.number().multipleOf(0.5).positive();
    for (let i = 0; i < 50; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });
});

describe('string: combined constraint formats', () => {
  it('startsWith + endsWith combined', () => {
    const schema = z.string().startsWith('hello').endsWith('.txt');
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('startsWith + includes combined', () => {
    const schema = z.string().startsWith('PRJ-').includes('-ITEM-');
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('all three: startsWith + includes + endsWith', () => {
    const schema = z.string().startsWith('BEGIN_').includes('_MID_').endsWith('_END');
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('startsWith + min length constraint', () => {
    const schema = z.string().startsWith('hello').min(20);
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('endsWith + min length constraint', () => {
    const schema = z.string().endsWith('.txt').min(15);
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('startsWith + endsWith + min + max length constraints', () => {
    const schema = z.string().startsWith('hi').endsWith('!').min(10).max(20);
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('includes + max length constraint', () => {
    const schema = z.string().includes('world').max(15);
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// multipleOf floating-point precision
// ---------------------------------------------------------------------------

describe('number: multipleOf floating-point precision', () => {
  it('multipleOf(0.1) produces valid multiples', () => {
    const schema = z.number().multipleOf(0.1);
    for (let i = 0; i < 50; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('multipleOf(0.01) produces valid multiples', () => {
    const schema = z.number().multipleOf(0.01);
    for (let i = 0; i < 50; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('multipleOf(0.001) with range produces valid multiples', () => {
    const schema = z.number().multipleOf(0.001).gte(0).lte(100);
    for (let i = 0; i < 50; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Record with typed keys
// ---------------------------------------------------------------------------

describe('record with typed keys', () => {
  it('enum-keyed record produces all required keys', () => {
    const schema = z.record(z.enum(['a', 'b', 'c']), z.number());
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('string-keyed record with min length produces valid keys', () => {
    const schema = z.record(z.string().min(5), z.number());
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });

  it('plain string-keyed record still works', () => {
    const schema = z.record(z.string(), z.string().email());
    for (let i = 0; i < 30; i++) {
      const val = generateFromSchema(schema as any, { seed: i });
      expect(schema.safeParse(val).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Nullable + nested overrides
// ---------------------------------------------------------------------------

describe('nullable + nested overrides', () => {
  it('never returns null when overrides target inner fields', () => {
    const schema = z.object({
      address: z.nullable(z.object({
        city: z.string(),
        zip: z.string(),
      })),
    });
    // Run many times — the old bug had ~10% null rate
    for (let i = 0; i < 200; i++) {
      const result = generateFromSchema<any>(schema as any, {
        overrides: { 'address.city': 'Portland' },
      });
      expect(result.address).not.toBeNull();
      expect(result.address.city).toBe('Portland');
    }
  });

  it('never returns null when override targets the nullable field directly', () => {
    const schema = z.object({
      name: z.nullable(z.string()),
    });
    for (let i = 0; i < 200; i++) {
      const result = generateFromSchema<any>(schema as any, {
        overrides: { name: 'Alice' },
      });
      expect(result.name).toBe('Alice');
    }
  });

  it('still returns null sometimes when no overrides present', () => {
    const schema = z.object({
      tag: z.nullable(z.string()),
    });
    let nullCount = 0;
    for (let i = 0; i < 500; i++) {
      const result = generateFromSchema<any>(schema as any);
      if (result.tag === null) nullCount++;
    }
    // Should see some nulls (~10% of 500 = ~50)
    expect(nullCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Optional + nested overrides (standalone)
// ---------------------------------------------------------------------------

describe('optional + nested overrides', () => {
  it('never returns undefined when standalone optional wraps object with overrides', () => {
    const schema = z.optional(z.object({ city: z.string(), zip: z.string() }));
    for (let i = 0; i < 200; i++) {
      const result = generateFromSchema<any>(schema as any, {
        overrides: { city: 'Portland' },
      });
      expect(result).toBeDefined();
      expect(result.city).toBe('Portland');
    }
  });

  it('still returns undefined sometimes when no overrides present', () => {
    const schema = z.optional(z.string());
    let undefinedCount = 0;
    for (let i = 0; i < 500; i++) {
      const result = generateFromSchema<any>(schema as any);
      if (result === undefined) undefinedCount++;
    }
    expect(undefinedCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Date constraints
// ---------------------------------------------------------------------------

describe('date constraints', () => {
  it('respects min and max date bounds', () => {
    const minDate = new Date('2024-01-01');
    const maxDate = new Date('2024-12-31');
    const schema = z.date().min(minDate).max(maxDate);
    for (let i = 0; i < 100; i++) {
      const d = generateFromSchema<Date>(schema as any);
      expect(d).toBeInstanceOf(Date);
      expect(d.getTime()).toBeGreaterThanOrEqual(minDate.getTime());
      expect(d.getTime()).toBeLessThanOrEqual(maxDate.getTime());
    }
  });

  it('respects min-only date bound', () => {
    const minDate = new Date('2025-06-01');
    const schema = z.date().min(minDate);
    for (let i = 0; i < 50; i++) {
      const d = generateFromSchema<Date>(schema as any);
      expect(d).toBeInstanceOf(Date);
      expect(d.getTime()).toBeGreaterThanOrEqual(minDate.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// Empty multipleOf range
// ---------------------------------------------------------------------------

describe('empty multipleOf range', () => {
  it('does not throw when no valid multiple exists in range', () => {
    // gt(1).lt(3).multipleOf(5) — no multiple of 5 between 1 and 3
    const schema = z.number().gt(1).lt(3).multipleOf(5);
    expect(() => generateFromSchema<number>(schema as any)).not.toThrow();
  });

  it('returns a number (nearest valid multiple)', () => {
    const schema = z.number().gt(1).lt(3).multipleOf(5);
    const val = generateFromSchema<number>(schema as any);
    expect(typeof val).toBe('number');
    expect(Number.isNaN(val)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// z.object().required() — nonoptional wrapping optional
// ---------------------------------------------------------------------------

describe('nonoptional (z.object().required())', () => {
  it('always includes fields made required via .required()', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().optional(),
    }).required();
    for (let i = 0; i < 200; i++) {
      const result = generateFromSchema<any>(schema as any);
      expect(result.a).toBeDefined();
      expect(typeof result.a).toBe('string');
      expect(result.b).toBeDefined();
      expect(typeof result.b).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Numeric nativeEnum
// ---------------------------------------------------------------------------

describe('numeric nativeEnum', () => {
  enum Priority { Low = 0, Medium = 1, High = 2 }

  it('only generates numeric values, not reverse-mapped strings', () => {
    const schema = z.nativeEnum(Priority);
    for (let i = 0; i < 100; i++) {
      const val = generateFromSchema<Priority>(schema as any);
      expect(typeof val).toBe('number');
      expect([0, 1, 2]).toContain(val);
    }
  });

  it('generates correct keys for enum-keyed record with numeric nativeEnum', () => {
    const schema = z.record(z.nativeEnum(Priority), z.string());
    const result = generateFromSchema<any>(schema as any);
    const keys = Object.keys(result).sort();
    // Keys should be "0", "1", "2" (JS object keys are always strings)
    expect(keys).toEqual(['0', '1', '2']);
  });

  it('still works correctly with string nativeEnums', () => {
    enum Color { Red = 'red', Green = 'green', Blue = 'blue' }
    const schema = z.nativeEnum(Color);
    for (let i = 0; i < 100; i++) {
      const val = generateFromSchema<Color>(schema as any);
      expect(['red', 'green', 'blue']).toContain(val);
    }
  });
});

// ---------------------------------------------------------------------------
// generateExample with non-serializable types
// ---------------------------------------------------------------------------

describe('generateExample', () => {
  it('handles BigInt fields without crashing', () => {
    const schema = z.object({
      id: z.bigint(),
      name: z.string(),
    });
    const example = generateExample(schema as any);
    expect(example).toBeDefined();
    expect(typeof (example as any).id).toBe('number');
    expect(typeof (example as any).name).toBe('string');
  });
});
