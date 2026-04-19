/**
 * Additional coverage tests for src/framework/lib/pagination.ts
 *
 * Targets functions defined in this file (not re-exports from slingshot-core):
 *   - cursorParams (lines 29-42)
 *   - parseCursorParams (lines 44-64)
 *   - maybeSignCursor (lines 66-75)
 *   - cursorResponse (lines 77-85)
 */
import { describe, expect, test } from 'bun:test';
import {
  cursorParams,
  cursorResponse,
  maybeSignCursor,
  parseCursorParams,
} from '../../src/framework/lib/pagination';
import { signCursor, verifyCursor } from '../../src/lib/signing';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// cursorParams — schema shape and default descriptions
// ---------------------------------------------------------------------------

describe('cursorParams coverage', () => {
  test('generates schema with default limit=50 and maxLimit=200 descriptions', () => {
    const schema = cursorParams();
    const parsed = schema.parse({});
    expect(parsed).toEqual({ limit: undefined, cursor: undefined });
    expect(schema.shape.limit.description).toContain('50');
    expect(schema.shape.limit.description).toContain('200');
  });

  test('generates schema with custom defaults reflected in descriptions', () => {
    const schema = cursorParams({ limit: 10, maxLimit: 100 });
    expect(schema.shape.limit.description).toContain('100');
    expect(schema.shape.limit.description).toContain('10');
    expect(schema.shape.cursor.description).toContain('nextCursor');
  });

  test('parses string values for both fields', () => {
    const schema = cursorParams();
    const result = schema.parse({ limit: '25', cursor: 'abc' });
    expect(result).toEqual({ limit: '25', cursor: 'abc' });
  });
});

// ---------------------------------------------------------------------------
// parseCursorParams — all branches
// ---------------------------------------------------------------------------

describe('parseCursorParams coverage', () => {
  test('defaults limit to 50 and cursor to undefined with empty input', () => {
    const result = parseCursorParams({});
    expect(result.limit).toBe(50);
    expect(result.cursor).toBeUndefined();
  });

  test('clamps limit to 1 when below minimum', () => {
    const result = parseCursorParams({ limit: '-10' });
    expect(result.limit).toBe(1);
  });

  test('clamps limit to maxLimit when above maximum', () => {
    const result = parseCursorParams({ limit: '500' });
    expect(result.limit).toBe(200);
  });

  test('uses custom defaults for limit and maxLimit', () => {
    const result = parseCursorParams({}, { limit: 25, maxLimit: 80 });
    expect(result.limit).toBe(25);
  });

  test('clamps to custom maxLimit', () => {
    const result = parseCursorParams({ limit: '100' }, { maxLimit: 80 });
    expect(result.limit).toBe(80);
  });

  test('falls back to defaultLimit for NaN input', () => {
    const result = parseCursorParams({ limit: 'not-a-number' });
    expect(result.limit).toBe(50);
  });

  test('returns cursor as-is when no signing config is provided', () => {
    const result = parseCursorParams({ cursor: 'raw-cursor-val' });
    expect(result.cursor).toBe('raw-cursor-val');
  });

  test('returns cursor as-is when signing config cursors is false', () => {
    const result = parseCursorParams(
      { cursor: 'my-cursor' },
      undefined,
      { config: { cursors: false } as any, secret: 'secret' },
    );
    expect(result.cursor).toBe('my-cursor');
  });

  test('returns cursor as-is when signing secret is null', () => {
    const result = parseCursorParams(
      { cursor: 'my-cursor' },
      undefined,
      { config: { cursors: true } as any, secret: null },
    );
    expect(result.cursor).toBe('my-cursor');
  });

  test('verifies and returns decoded cursor when signing is active', () => {
    const secret = 'test-secret-for-pagination-coverage';
    const signed = signCursor('page-5', secret);
    const result = parseCursorParams(
      { cursor: signed },
      undefined,
      { config: { cursors: true } as any, secret },
    );
    expect(result.cursor).toBe('page-5');
    expect(result.invalidCursor).toBeUndefined();
  });

  test('returns invalidCursor when signed cursor is tampered', () => {
    const secret = 'test-secret-for-pagination-coverage';
    const result = parseCursorParams(
      { cursor: 'tampered.value' },
      undefined,
      { config: { cursors: true } as any, secret },
    );
    expect(result.cursor).toBeUndefined();
    expect(result.invalidCursor).toBe(true);
  });

  test('returns undefined cursor for empty string', () => {
    const result = parseCursorParams({ cursor: '' });
    expect(result.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// maybeSignCursor — all branches
// ---------------------------------------------------------------------------

describe('maybeSignCursor coverage', () => {
  test('returns null when cursor is null', () => {
    expect(maybeSignCursor(null)).toBeNull();
  });

  test('returns cursor as-is when no signing arg is provided', () => {
    expect(maybeSignCursor('cursor-value')).toBe('cursor-value');
  });

  test('returns cursor as-is when signing.config is null', () => {
    expect(maybeSignCursor('cursor-value', { config: null, secret: 'sec' })).toBe('cursor-value');
  });

  test('returns cursor as-is when signing.config.cursors is false', () => {
    const signing = { config: { cursors: false } as any, secret: 'sec' };
    expect(maybeSignCursor('cursor-value', signing)).toBe('cursor-value');
  });

  test('returns cursor as-is when signing.secret is null', () => {
    const signing = { config: { cursors: true } as any, secret: null };
    expect(maybeSignCursor('cursor-value', signing)).toBe('cursor-value');
  });

  test('signs cursor when both cursors config and secret are present', () => {
    const secret = 'test-secret-for-maybe-sign-coverage';
    const signing = { config: { cursors: true } as any, secret };
    const signed = maybeSignCursor('page-7', signing);
    expect(typeof signed).toBe('string');
    expect(signed).not.toBe('page-7');
    // Verify the signed cursor round-trips
    expect(verifyCursor(signed!, secret)).toBe('page-7');
  });
});

// ---------------------------------------------------------------------------
// cursorResponse — schema shape and registration
// ---------------------------------------------------------------------------

describe('cursorResponse coverage', () => {
  test('creates schema with items, nextCursor, hasMore', () => {
    const itemSchema = z.object({ id: z.string() });
    const schema = cursorResponse(itemSchema, 'PaginationCoverageTest_Shape');
    const data = { items: [{ id: 'a' }], nextCursor: null, hasMore: false };
    expect(schema.parse(data)).toEqual(data);
  });

  test('nextCursor accepts string value', () => {
    const itemSchema = z.object({ n: z.number() });
    const schema = cursorResponse(itemSchema, 'PaginationCoverageTest_NextStr');
    const data = { items: [{ n: 1 }], nextCursor: 'tok_abc', hasMore: true };
    expect(schema.parse(data)).toEqual(data);
  });

  test('items must match the provided item schema', () => {
    const itemSchema = z.object({ required: z.string() });
    const schema = cursorResponse(itemSchema, 'PaginationCoverageTest_Validate');
    expect(() => schema.parse({ items: [{ wrong: 1 }], nextCursor: null, hasMore: false })).toThrow();
  });
});
