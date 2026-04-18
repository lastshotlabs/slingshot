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
import { generateFromSchema, generateMany } from '../../src/faker';

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
