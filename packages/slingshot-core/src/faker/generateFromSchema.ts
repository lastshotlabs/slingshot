/**
 * Public API for generating fake data from any Zod schema.
 *
 * @example
 * ```ts
 * import { generateFromSchema, generateMany } from '@lastshotlabs/slingshot-core/faker';
 * import { z } from 'zod';
 *
 * const userSchema = z.object({
 *   name: z.string(),
 *   email: z.string().email(),
 *   role: z.enum(['admin', 'member']),
 * });
 *
 * // Single record
 * const user = generateFromSchema(userSchema);
 * // => { name: "lorem ipsum", email: "aria@example.com", role: "member" }
 *
 * // With overrides
 * const admin = generateFromSchema(userSchema, { overrides: { role: 'admin' } });
 *
 * // Deterministic output
 * const repeatable = generateFromSchema(userSchema, { seed: 42 });
 *
 * // Many records
 * const users = generateMany(userSchema, 10);
 * ```
 *
 * @module
 */
import { faker as defaultFaker, type Faker } from '@faker-js/faker';
import { walkSchema, type WalkOptions } from './zodWalker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for `generateFromSchema`. */
export interface GenerateOptions {
  /**
   * Deterministic seed. When set, the same schema + seed always produces
   * the same output. Useful for reproducible demos and snapshots.
   */
  seed?: number;
  /**
   * Override specific field paths with fixed values.
   * Keys use dot-notation: `{ "address.city": "Portland" }`.
   */
  overrides?: Record<string, unknown>;
  /**
   * Maximum recursion depth for `z.lazy()` schemas. Defaults to 2.
   */
  maxDepth?: number;
  /**
   * Probability (0–1) that an optional field is included. Defaults to 0.7.
   */
  optionalRate?: number;
  /**
   * Faker instance override. When omitted a fresh instance is created
   * (seeded if `seed` is provided, otherwise the global singleton).
   */
  faker?: Faker;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the faker instance to use for a generation run.
 */
function resolveFaker(opts: GenerateOptions): Faker {
  if (opts.faker) {
    if (opts.seed !== undefined) opts.faker.seed(opts.seed);
    return opts.faker;
  }
  if (opts.seed !== undefined) {
    defaultFaker.seed(opts.seed);
    return defaultFaker;
  }
  return defaultFaker;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a single fake value that conforms to the given Zod schema.
 *
 * Works with any Zod 4 schema — objects, primitives, arrays, unions,
 * enums, pipes, intersections, lazy schemas, etc. Format-aware: a
 * `z.string().email()` produces a realistic email, `z.string().uuid()`
 * produces a UUID, and so on.
 */
export function generateFromSchema<T>(
  schema: { _zod: { def: { type: string } } },
  opts: GenerateOptions = {},
): T {
  const f = resolveFaker(opts);
  const walkOpts: WalkOptions = {
    faker: f,
    overrides: opts.overrides,
    maxDepth: opts.maxDepth,
    optionalRate: opts.optionalRate,
  };
  return walkSchema(schema as Parameters<typeof walkSchema>[0], walkOpts) as T;
}

/**
 * Generate multiple fake values for a given schema.
 *
 * @param schema - Any Zod schema.
 * @param count  - Number of records to generate.
 * @param opts   - Same options as `generateFromSchema`. When `seed` is set,
 *                 the sequence is deterministic.
 */
export function generateMany<T>(
  schema: { _zod: { def: { type: string } } },
  count: number,
  opts: GenerateOptions = {},
): T[] {
  const f = resolveFaker(opts);
  const walkOpts: WalkOptions = {
    faker: f,
    overrides: opts.overrides,
    maxDepth: opts.maxDepth,
    optionalRate: opts.optionalRate,
  };
  return Array.from({ length: count }, () =>
    walkSchema(schema as Parameters<typeof walkSchema>[0], walkOpts) as T,
  );
}

/**
 * Generate a JSON-serializable example for documentation / OpenAPI specs.
 *
 * Uses seed 42 and 100% optional rate so output is deterministic and
 * includes all fields. Strips undefined values.
 */
export function generateExample<T>(
  schema: { _zod: { def: { type: string } } },
  overrides?: Record<string, unknown>,
): T {
  const result = generateFromSchema<T>(schema, {
    seed: 42,
    optionalRate: 1.0,
    overrides,
  });
  // Strip undefined for JSON-clean output
  return JSON.parse(JSON.stringify(result)) as T;
}
