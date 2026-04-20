/**
 * Coverage-targeted tests for zodWalker.ts uncovered branches.
 *
 * Covers: string length_equals/regex, all format cases (ipv6, cidrv4/v6, time,
 * duration, cuid/cuid2/ulid/nanoid/xid/ksuid, base64/base64url, e164, jwt,
 * emoji, lowercase, uppercase, mac), int type, nan, never, symbol,
 * tuple rest, default/prefault/catch/nonoptional/readonly/success wrappers,
 * pipe, transform, intersection non-object, lazy depth exceeded,
 * custom, template_literal, promise, function, file.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { walkSchema } from '../../src/faker';

// Helper to create a mock Zod schema node for types not easily constructed
// through the public z.* API.
function mockSchema(def: Record<string, unknown>): any {
  return { _zod: { def } };
}

// ---------------------------------------------------------------------------
// String: length_equals check
// ---------------------------------------------------------------------------

describe('string length_equals', () => {
  test('z.string().length(10) produces exactly 10 chars', () => {
    const schema = z.string().length(10);
    for (let i = 0; i < 20; i++) {
      const val = walkSchema(schema as any, { seed: i }) as string;
      expect(val).toHaveLength(10);
    }
  });
});

// ---------------------------------------------------------------------------
// String: regex check
// ---------------------------------------------------------------------------

describe('string regex', () => {
  test('z.string().regex() is handled without error', () => {
    const schema = z.string().regex(/^[A-Z]{3}$/);
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// String format: ipv6
// ---------------------------------------------------------------------------

describe('string format: ipv6', () => {
  test('z.ipv6() produces a string', () => {
    const schema = z.ipv6();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
    expect(val).toContain(':');
  });
});

// ---------------------------------------------------------------------------
// String format: cidrv4, cidrv6
// ---------------------------------------------------------------------------

describe('string format: cidr', () => {
  test('cidrv4 format via mock', () => {
    const schema = z.cidrv4();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).toContain('/');
  });

  test('cidrv6 format via mock', () => {
    const schema = z.cidrv6();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).toContain('/');
    expect(val).toContain(':');
  });
});

// ---------------------------------------------------------------------------
// String format: time
// ---------------------------------------------------------------------------

describe('string format: time', () => {
  test('z.string().time() produces a time string', () => {
    const schema = z.string().time();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
    expect(val).toContain(':');
  });

  test('z.string().time({ precision: 0 }) produces no fractional seconds', () => {
    const schema = z.string().time({ precision: 0 });
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).not.toContain('.');
  });

  test('z.string().time({ precision: 3 }) produces 3-digit fraction', () => {
    const schema = z.string().time({ precision: 3 });
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).toContain('.');
    const frac = val.split('.')[1];
    expect(frac).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// String format: duration
// ---------------------------------------------------------------------------

describe('string format: duration', () => {
  test('z.string().duration() produces P...D format', () => {
    const schema = z.string().duration();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).toMatch(/^P\d+D$/);
  });
});

// ---------------------------------------------------------------------------
// String format: e164
// ---------------------------------------------------------------------------

describe('string format: e164', () => {
  test('z.string().e164() produces +1 followed by 10 digits', () => {
    const schema = z.string().e164();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).toMatch(/^\+1\d{10}$/);
  });
});

// ---------------------------------------------------------------------------
// String format: jwt
// ---------------------------------------------------------------------------

describe('string format: jwt', () => {
  test('z.string().jwt() produces three dot-separated segments', () => {
    const schema = z.string().jwt();
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    const parts = val.split('.');
    expect(parts).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// String format: emoji
// ---------------------------------------------------------------------------

describe('string format: emoji', () => {
  test('emoji format via mock', () => {
    const schema = mockSchema({ type: 'string', format: 'emoji' });
    const val = walkSchema(schema, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
    expect(val.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// String format: lowercase, uppercase
// ---------------------------------------------------------------------------

describe('string format: lowercase/uppercase', () => {
  test('lowercase format via mock', () => {
    const schema = mockSchema({ type: 'string', format: 'lowercase' });
    const val = walkSchema(schema, { seed: 1 }) as string;
    expect(val).toBe(val.toLowerCase());
  });

  test('uppercase format via mock', () => {
    const schema = mockSchema({ type: 'string', format: 'uppercase' });
    const val = walkSchema(schema, { seed: 1 }) as string;
    expect(val).toBe(val.toUpperCase());
  });
});

// ---------------------------------------------------------------------------
// String format: mac
// ---------------------------------------------------------------------------

describe('string format: mac', () => {
  test('mac format via mock', () => {
    const schema = mockSchema({ type: 'string', format: 'mac' });
    const val = walkSchema(schema, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
    expect(val).toContain(':');
  });
});

// ---------------------------------------------------------------------------
// int type (z.int() uses 'int' type in Zod 4)
// ---------------------------------------------------------------------------

describe('int type', () => {
  test('z.int() produces integers', () => {
    const schema = z.int();
    const val = walkSchema(schema as any, { seed: 1 }) as number;
    expect(Number.isInteger(val)).toBe(true);
  });

  test('z.int().min(5).max(10) with exclusive bounds', () => {
    const schema = z.int().gt(5).lt(10);
    for (let i = 0; i < 50; i++) {
      const val = walkSchema(schema as any, { seed: i }) as number;
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThan(5);
      expect(val).toBeLessThan(10);
    }
  });

  test('z.int() with negative max produces negative default range', () => {
    const schema = z.int().lt(-5);
    for (let i = 0; i < 20; i++) {
      const val = walkSchema(schema as any, { seed: i }) as number;
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeLessThan(-5);
    }
  });

  test('z.int() with large min produces shifted range', () => {
    const schema = z.int().gt(20000);
    for (let i = 0; i < 20; i++) {
      const val = walkSchema(schema as any, { seed: i }) as number;
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThan(20000);
    }
  });

  test('z.int() empty range returns intMin', () => {
    // gt(5).lt(6) means min=6, max=5 for integers → intMin > intMax → returns intMin
    const schema = z.int().gt(5).lt(6);
    const val = walkSchema(schema as any, { seed: 1 }) as number;
    expect(typeof val).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// nan type
// ---------------------------------------------------------------------------

describe('nan type', () => {
  test('z.nan() produces NaN', () => {
    const schema = z.nan();
    const val = walkSchema(schema as any, { seed: 1 }) as number;
    expect(Number.isNaN(val)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// never type
// ---------------------------------------------------------------------------

describe('never type', () => {
  test('z.never() throws', () => {
    const schema = z.never();
    expect(() => walkSchema(schema as any, { seed: 1 })).toThrow(
      'Cannot generate a value for z.never()',
    );
  });
});

// ---------------------------------------------------------------------------
// symbol type
// ---------------------------------------------------------------------------

describe('symbol type', () => {
  test('z.symbol() produces a symbol', () => {
    const schema = z.symbol();
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('symbol');
  });
});

// ---------------------------------------------------------------------------
// tuple with rest
// ---------------------------------------------------------------------------

describe('tuple with rest', () => {
  test('z.tuple([...]).rest(z.string()) adds extra items', () => {
    const schema = z.tuple([z.number()]).rest(z.string());
    // Run multiple times — some should have extra items
    let hadExtra = false;
    for (let i = 0; i < 50; i++) {
      const val = walkSchema(schema as any, { seed: i }) as unknown[];
      expect(typeof val[0]).toBe('number');
      if (val.length > 1) {
        hadExtra = true;
        for (let j = 1; j < val.length; j++) {
          expect(typeof val[j]).toBe('string');
        }
      }
    }
    expect(hadExtra).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// default wrapper without inner type
// ---------------------------------------------------------------------------

describe('default wrapper', () => {
  test('default without innerType returns defaultValue', () => {
    const schema = mockSchema({
      type: 'default',
      defaultValue: 'fallback-val',
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBe('fallback-val');
  });

  test('default without innerType calls function defaultValue', () => {
    const schema = mockSchema({
      type: 'default',
      defaultValue: () => 42,
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBe(42);
  });

  test('default with innerType walks inner', () => {
    z.string();
    const schema = z.string().default('fb');
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// prefault wrapper
// ---------------------------------------------------------------------------

describe('prefault wrapper', () => {
  test('prefault without innerType returns defaultValue', () => {
    const schema = mockSchema({
      type: 'prefault',
      defaultValue: 'pre-val',
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBe('pre-val');
  });

  test('prefault without innerType calls function defaultValue', () => {
    const schema = mockSchema({
      type: 'prefault',
      defaultValue: () => 99,
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBe(99);
  });

  test('prefault with innerType walks inner', () => {
    const inner = z.number();
    const schema = mockSchema({
      type: 'prefault',
      defaultValue: 'ignored',
      innerType: inner,
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// catch wrapper
// ---------------------------------------------------------------------------

describe('catch wrapper', () => {
  test('catch without innerType returns undefined', () => {
    const schema = mockSchema({ type: 'catch' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeUndefined();
  });

  test('catch with innerType walks inner', () => {
    const schema = z.string().catch('fallback');
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// nonoptional wrapper
// ---------------------------------------------------------------------------

describe('nonoptional wrapper', () => {
  test('nonoptional without innerType returns undefined', () => {
    const schema = mockSchema({ type: 'nonoptional' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeUndefined();
  });

  test('nonoptional skips inner optional wrapper', () => {
    // z.object({ a: z.string().optional() }).required() wraps each field in nonoptional
    const schema = z.object({ a: z.string().optional() }).required();
    for (let i = 0; i < 50; i++) {
      const val = walkSchema(schema as any, { seed: i }) as any;
      expect(val.a).toBeDefined();
      expect(typeof val.a).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// readonly wrapper
// ---------------------------------------------------------------------------

describe('readonly wrapper', () => {
  test('readonly walks innerType', () => {
    const schema = z.string().readonly();
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });

  test('readonly without innerType returns undefined', () => {
    const schema = mockSchema({ type: 'readonly' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// success wrapper
// ---------------------------------------------------------------------------

describe('success wrapper', () => {
  test('success with innerType walks inner', () => {
    const schema = mockSchema({
      type: 'success',
      innerType: z.number(),
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('number');
  });

  test('success without innerType returns undefined', () => {
    const schema = mockSchema({ type: 'success' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pipe wrapper
// ---------------------------------------------------------------------------

describe('pipe wrapper', () => {
  test('pipe with in schema walks input side', () => {
    const schema = z.string().pipe(z.string().min(1));
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });

  test('pipe without in but with innerType walks innerType', () => {
    const schema = mockSchema({
      type: 'pipe',
      innerType: z.number(),
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('number');
  });

  test('pipe without in or innerType returns undefined', () => {
    const schema = mockSchema({ type: 'pipe' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// transform wrapper
// ---------------------------------------------------------------------------

describe('transform wrapper', () => {
  test('transform produces a string', () => {
    const schema = z.string().transform(s => s.toUpperCase());
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// intersection with non-object values
// ---------------------------------------------------------------------------

describe('intersection non-object', () => {
  test('intersection of non-objects returns leftVal', () => {
    const schema = z.intersection(z.string(), z.string());
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });

  test('intersection without left or right returns empty object', () => {
    const schema = mockSchema({ type: 'intersection' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// lazy depth exceeded
// ---------------------------------------------------------------------------

describe('lazy depth exceeded', () => {
  test('lazy returns null when depth >= maxDepth', () => {
    type Rec = { child: Rec | null };
    const schema: z.ZodType<Rec> = z.object({
      child: z.lazy(() => schema).nullable(),
    });
    // maxDepth=0 means first lazy call immediately returns null
    const val = walkSchema(schema as any, { seed: 1, maxDepth: 0 }) as any;
    expect(val.child).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// custom type
// ---------------------------------------------------------------------------

describe('custom type', () => {
  test('z.custom() produces a word', () => {
    const schema = z.custom<string>();
    const val = walkSchema(schema as any, { seed: 1 });
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// template_literal type
// ---------------------------------------------------------------------------

describe('template_literal type', () => {
  test('template_literal via mock produces a word', () => {
    const schema = mockSchema({ type: 'template_literal' });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// promise type
// ---------------------------------------------------------------------------

describe('promise type', () => {
  test('promise with innerType resolves to walked value', async () => {
    const schema = mockSchema({
      type: 'promise',
      innerType: z.number(),
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeInstanceOf(Promise);
    const resolved = await val;
    expect(typeof resolved).toBe('number');
  });

  test('promise without innerType resolves to undefined', async () => {
    const schema = mockSchema({ type: 'promise' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeInstanceOf(Promise);
    const resolved = await val;
    expect(resolved).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// function type
// ---------------------------------------------------------------------------

describe('function type', () => {
  test('function type returns a function', () => {
    const schema = mockSchema({ type: 'function' });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// file type
// ---------------------------------------------------------------------------

describe('file type', () => {
  test('file type returns a Blob', () => {
    const schema = mockSchema({ type: 'file' });
    const val = walkSchema(schema, { seed: 1 });
    expect(val).toBeInstanceOf(Blob);
  });
});

// ---------------------------------------------------------------------------
// number with exclusive float inverted range
// ---------------------------------------------------------------------------

describe('number inverted float range', () => {
  test('exclusive bounds creating inverted range returns midpoint', () => {
    // gt(5.0000000001).lt(5.0000000002) — after nudging, floatMin > floatMax
    const schema = mockSchema({
      type: 'number',
      checks: [
        { _zod: { def: { check: 'greater_than', value: 5.00000000000001, inclusive: false } } },
        { _zod: { def: { check: 'less_than', value: 5.00000000000002, inclusive: false } } },
      ],
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// datetime with local flag
// ---------------------------------------------------------------------------

describe('datetime local', () => {
  test('z.string().datetime({ local: true }) omits Z', () => {
    const schema = z.string().datetime({ local: true });
    const val = walkSchema(schema as any, { seed: 1 }) as string;
    expect(val).not.toContain('Z');
  });
});

// ---------------------------------------------------------------------------
// String: regex check in extractStringConstraints (lines 173-178)
// ---------------------------------------------------------------------------

describe('string regex check via mock', () => {
  test('regex check populates patterns array', () => {
    // Construct a schema with a regex check that extractStringConstraints picks up
    const schema = mockSchema({
      type: 'string',
      checks: [{ _zod: { def: { check: 'regex', pattern: /^test/ } } }],
    });
    const val = walkSchema(schema, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// String format: base64url (line 359)
// ---------------------------------------------------------------------------

describe('string format: base64url', () => {
  test('base64url format via mock produces a string', () => {
    const schema = mockSchema({ type: 'string', format: 'base64url' });
    const val = walkSchema(schema, { seed: 1 }) as string;
    expect(typeof val).toBe('string');
    expect(val.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// int type via mock (lines 508-521 - the dedicated 'int' case)
// ---------------------------------------------------------------------------

describe('int type via mock', () => {
  test('basic int type', () => {
    const schema = mockSchema({ type: 'int' });
    const val = walkSchema(schema, { seed: 1 }) as number;
    expect(Number.isInteger(val)).toBe(true);
  });

  test('int type with exclusive bounds', () => {
    const schema = mockSchema({
      type: 'int',
      checks: [
        { _zod: { def: { check: 'greater_than', value: 5, inclusive: false } } },
        { _zod: { def: { check: 'less_than', value: 10, inclusive: false } } },
      ],
    });
    const val = walkSchema(schema, { seed: 1 }) as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThan(5);
    expect(val).toBeLessThan(10);
  });

  test('int type with negative max (effectiveMax < 0 default range)', () => {
    const schema = mockSchema({
      type: 'int',
      checks: [{ _zod: { def: { check: 'less_than', value: -5, inclusive: true } } }],
    });
    const val = walkSchema(schema, { seed: 1 }) as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeLessThanOrEqual(-5);
  });

  test('int type with large min (effectiveMin > 10000 default range)', () => {
    const schema = mockSchema({
      type: 'int',
      checks: [{ _zod: { def: { check: 'greater_than', value: 20000, inclusive: true } } }],
    });
    const val = walkSchema(schema, { seed: 1 }) as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(20000);
  });

  test('int type empty range returns intMin', () => {
    const schema = mockSchema({
      type: 'int',
      checks: [
        { _zod: { def: { check: 'greater_than', value: 5, inclusive: false } } },
        { _zod: { def: { check: 'less_than', value: 6, inclusive: false } } },
      ],
    });
    const val = walkSchema(schema, { seed: 1 }) as number;
    expect(typeof val).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// pipe via mock (line 888 — innerType fallback, line 889 — return undefined)
// ---------------------------------------------------------------------------

describe('pipe via mock', () => {
  test('pipe with innerType but no in walks innerType', () => {
    const schema = mockSchema({
      type: 'pipe',
      innerType: z.boolean(),
    });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// transform via mock (lines 892-894)
// ---------------------------------------------------------------------------

describe('transform via mock', () => {
  test('transform type produces a string', () => {
    const schema = mockSchema({ type: 'transform' });
    const val = walkSchema(schema, { seed: 1 });
    expect(typeof val).toBe('string');
  });
});
