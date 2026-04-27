import { getRefId } from '@asteasolutions/zod-to-openapi';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  cursorParams,
  cursorResponse,
  offsetParams,
  paginatedResponse,
  parseCursorParams,
  parseOffsetParams,
} from '../../src/framework/lib/pagination';

// ---------------------------------------------------------------------------
// offsetParams
// ---------------------------------------------------------------------------

describe('offsetParams', () => {
  it('returns a Zod object with limit and offset as optional strings', () => {
    const schema = offsetParams();
    const shape = schema.shape;
    expect(shape.limit).toBeDefined();
    expect(shape.offset).toBeDefined();
    // Both fields accept undefined
    expect(schema.parse({})).toEqual({ limit: undefined, offset: undefined });
    // Both fields accept string values
    expect(schema.parse({ limit: '10', offset: '20' })).toEqual({ limit: '10', offset: '20' });
  });

  it('embeds custom defaults in field descriptions', () => {
    const schema = offsetParams({ limit: 25, maxLimit: 100, offset: 5 });
    const limitDesc = schema.shape.limit.description;
    const offsetDesc = schema.shape.offset.description;
    expect(limitDesc).toContain('25');
    expect(limitDesc).toContain('100');
    expect(offsetDesc).toContain('5');
  });

  it('embeds default defaults in field descriptions when none provided', () => {
    const schema = offsetParams();
    expect(schema.shape.limit.description).toContain('50');
    expect(schema.shape.limit.description).toContain('200');
  });
});

// ---------------------------------------------------------------------------
// parseOffsetParams
// ---------------------------------------------------------------------------

describe('parseOffsetParams', () => {
  it('returns defaults when called with empty object', () => {
    expect(parseOffsetParams({})).toEqual({ limit: 50, offset: 0 });
  });

  it('parses valid string values', () => {
    expect(parseOffsetParams({ limit: '10', offset: '20' })).toEqual({ limit: 10, offset: 20 });
  });

  it('clamps limit above maxLimit to maxLimit', () => {
    expect(parseOffsetParams({ limit: '999' })).toEqual({ limit: 200, offset: 0 });
  });

  it('clamps limit below 1 to 1', () => {
    expect(parseOffsetParams({ limit: '0' })).toEqual({ limit: 1, offset: 0 });
  });

  it('clamps negative limit to 1', () => {
    expect(parseOffsetParams({ limit: '-5' })).toEqual({ limit: 1, offset: 0 });
  });

  it('clamps negative offset to 0', () => {
    expect(parseOffsetParams({ offset: '-5' })).toEqual({ limit: 50, offset: 0 });
  });

  it('falls back to default on NaN (non-numeric string)', () => {
    expect(parseOffsetParams({ limit: 'abc', offset: 'xyz' })).toEqual({ limit: 50, offset: 0 });
  });

  it('truncates floats via parseInt (3.7 → 3)', () => {
    expect(parseOffsetParams({ limit: '3.7', offset: '1.9' })).toEqual({ limit: 3, offset: 1 });
  });

  it('respects custom defaults', () => {
    expect(parseOffsetParams({}, { limit: 20, maxLimit: 100 })).toEqual({ limit: 20, offset: 0 });
  });

  it('clamps to custom maxLimit', () => {
    expect(parseOffsetParams({ limit: '150' }, { maxLimit: 100 })).toEqual({
      limit: 100,
      offset: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// paginatedResponse
// ---------------------------------------------------------------------------

describe('paginatedResponse', () => {
  it('produces correct shape: items, total, limit, offset', () => {
    const ItemSchema = z.object({ id: z.string() });
    const schema = paginatedResponse(ItemSchema, 'PaginationTestOffsetShape');
    const shape = schema.shape;
    expect(shape.items).toBeDefined();
    expect(shape.total).toBeDefined();
    expect(shape.limit).toBeDefined();
    expect(shape.offset).toBeDefined();
    // Validate a concrete value
    expect(schema.parse({ items: [{ id: '1' }], total: 1, limit: 10, offset: 0 })).toEqual({
      items: [{ id: '1' }],
      total: 1,
      limit: 10,
      offset: 0,
    });
  });

  it('registers schema with the provided name', () => {
    const ItemSchema = z.object({ name: z.string() });
    const schema = paginatedResponse(ItemSchema, 'PaginationTestOffsetRegistered');
    expect(getRefId(schema as any)).toBe('PaginationTestOffsetRegistered');
  });

  it('creates a structurally equivalent schema when called twice with the same name', () => {
    const ItemSchema = z.object({ x: z.number() });
    const s1 = paginatedResponse(ItemSchema, 'PaginationTestOffsetIdempotent');
    const s2 = paginatedResponse(ItemSchema, 'PaginationTestOffsetIdempotent');
    // Each call creates a new wrapper, so referential equality is not guaranteed,
    // but both schemas should parse identically.
    const sample = { items: [{ x: 1 }], total: 1, limit: 10, offset: 0 };
    expect(s1.parse(sample)).toEqual(s2.parse(sample));
  });

  it('silently skips re-registration when same name is used for a different schema', () => {
    const s1 = z.object({ a: z.string() });
    const s2 = z.object({ b: z.string() });
    paginatedResponse(s1, 'PaginationTestOffsetCollision');
    // registerSchema silently skips schemas whose name is already registered,
    // so no error is thrown even with a different item schema.
    expect(() => paginatedResponse(s2, 'PaginationTestOffsetCollision')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cursorParams
// ---------------------------------------------------------------------------

describe('cursorParams', () => {
  it('returns a Zod object with limit and cursor as optional strings', () => {
    const schema = cursorParams();
    const shape = schema.shape;
    expect(shape.limit).toBeDefined();
    expect(shape.cursor).toBeDefined();
    expect(schema.parse({})).toEqual({ limit: undefined, cursor: undefined });
    expect(schema.parse({ limit: '10', cursor: 'abc123' })).toEqual({
      limit: '10',
      cursor: 'abc123',
    });
  });

  it('embeds custom defaults in limit description', () => {
    const schema = cursorParams({ limit: 10, maxLimit: 50 });
    expect(schema.shape.limit.description).toContain('10');
    expect(schema.shape.limit.description).toContain('50');
  });
});

// ---------------------------------------------------------------------------
// parseCursorParams
// ---------------------------------------------------------------------------

describe('parseCursorParams', () => {
  it('returns defaults when called with empty object', () => {
    expect(parseCursorParams({})).toEqual({ limit: 50, cursor: undefined });
  });

  it('passes cursor through as-is', () => {
    expect(parseCursorParams({ cursor: 'tok_abc' })).toEqual({ limit: 50, cursor: 'tok_abc' });
  });

  it('normalizes empty cursor string to undefined', () => {
    expect(parseCursorParams({ cursor: '' })).toEqual({ limit: 50, cursor: undefined });
  });

  it('clamps limit above maxLimit', () => {
    expect(parseCursorParams({ limit: '999' })).toEqual({ limit: 200, cursor: undefined });
  });

  it('clamps limit below 1 to 1', () => {
    expect(parseCursorParams({ limit: '0' })).toEqual({ limit: 1, cursor: undefined });
  });

  it('falls back to default on NaN', () => {
    expect(parseCursorParams({ limit: 'nope' })).toEqual({ limit: 50, cursor: undefined });
  });

  it('truncates floats (3.7 → 3)', () => {
    expect(parseCursorParams({ limit: '3.7' })).toEqual({ limit: 3, cursor: undefined });
  });

  it('respects custom defaults', () => {
    expect(parseCursorParams({}, { limit: 10, maxLimit: 50 })).toEqual({
      limit: 10,
      cursor: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// cursorResponse
// ---------------------------------------------------------------------------

describe('cursorResponse', () => {
  it('produces correct shape: items, nextCursor, hasMore', () => {
    const ItemSchema = z.object({ id: z.string() });
    const schema = cursorResponse(ItemSchema, 'PaginationTestCursorShape');
    const shape = schema.shape;
    expect(shape.items).toBeDefined();
    expect(shape.nextCursor).toBeDefined();
    expect(shape.hasMore).toBeDefined();
    expect(schema.parse({ items: [{ id: '1' }], nextCursor: 'tok_123', hasMore: true })).toEqual({
      items: [{ id: '1' }],
      nextCursor: 'tok_123',
      hasMore: true,
    });
    // null nextCursor is valid
    expect(schema.parse({ items: [], nextCursor: null, hasMore: false })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('registers schema with the provided name', () => {
    const ItemSchema = z.object({ val: z.number() });
    const schema = cursorResponse(ItemSchema, 'PaginationTestCursorRegistered');
    expect(getRefId(schema as any)).toBe('PaginationTestCursorRegistered');
  });

  it('creates a structurally equivalent schema when called twice with the same name', () => {
    const ItemSchema = z.object({ y: z.string() });
    const s1 = cursorResponse(ItemSchema, 'PaginationTestCursorIdempotent');
    const s2 = cursorResponse(ItemSchema, 'PaginationTestCursorIdempotent');
    // Each call creates a new wrapper, so referential equality is not guaranteed,
    // but both schemas should parse identically.
    const sample = { items: [{ y: 'hello' }], nextCursor: null, hasMore: false };
    expect(s1.parse(sample)).toEqual(s2.parse(sample));
  });

  it('silently skips re-registration when same name is used for a different schema', () => {
    const s1 = z.object({ c: z.string() });
    const s2 = z.object({ d: z.string() });
    cursorResponse(s1, 'PaginationTestCursorCollision');
    // registerSchema silently skips schemas whose name is already registered,
    // so no error is thrown even with a different item schema.
    expect(() => cursorResponse(s2, 'PaginationTestCursorCollision')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: createRoute integration
// ---------------------------------------------------------------------------

describe('round-trip: offsetParams + paginatedResponse in a route', () => {
  it('query schema validates and response schema is registered', async () => {
    const { createRoute } = await import('@lastshotlabs/slingshot-core');

    const ItemSchema = z.object({ id: z.string(), title: z.string() });
    const query = offsetParams({ limit: 10 });
    const response = paginatedResponse(ItemSchema, 'PaginationTestRoundTripOffset');

    createRoute({
      method: 'get',
      path: '/pagination-test-offset',
      request: { query },
      responses: {
        200: {
          content: { 'application/json': { schema: response } },
          description: 'ok',
        },
      },
    });

    // Response schema registered under the given name
    expect(getRefId(response as any)).toBe('PaginationTestRoundTripOffset');

    // Query schema parses correctly
    const parsed = query.parse({ limit: '5', offset: '10' });
    expect(parsed).toEqual({ limit: '5', offset: '10' });

    // Parse helpers produce correct numbers
    const { limit, offset } = parseOffsetParams(parsed as any);
    expect(limit).toBe(5);
    expect(offset).toBe(10);
  });
});

describe('round-trip: cursorParams + cursorResponse in a route', () => {
  it('query schema validates and response schema is registered', async () => {
    const { createRoute } = await import('@lastshotlabs/slingshot-core');

    const ItemSchema = z.object({ id: z.string() });
    const query = cursorParams({ limit: 20 });
    const response = cursorResponse(ItemSchema, 'PaginationTestRoundTripCursor');

    createRoute({
      method: 'get',
      path: '/pagination-test-cursor',
      request: { query },
      responses: {
        200: {
          content: { 'application/json': { schema: response } },
          description: 'ok',
        },
      },
    });

    expect(getRefId(response as any)).toBe('PaginationTestRoundTripCursor');

    const parsed = query.parse({ limit: '15', cursor: 'tok_xyz' });
    expect(parsed).toEqual({ limit: '15', cursor: 'tok_xyz' });

    const { limit, cursor } = parseCursorParams(parsed as any);
    expect(limit).toBe(15);
    expect(cursor).toBe('tok_xyz');
  });
});

// ---------------------------------------------------------------------------
// parseCursorParams — signing branch (lines 58-60)
// ---------------------------------------------------------------------------

describe('parseCursorParams — signing', () => {
  it('returns cursor as-is when signing config has cursors disabled', () => {
    const signing = { config: { cursors: false }, secret: 'secret' };
    const result = parseCursorParams({ cursor: 'raw-cursor' }, undefined, signing as any);
    expect(result.cursor).toBe('raw-cursor');
  });

  it('returns cursor when signing config is present but no secret', () => {
    const signing = { config: { cursors: true }, secret: null };
    const result = parseCursorParams({ cursor: 'raw-cursor' }, undefined, signing as any);
    expect(result.cursor).toBe('raw-cursor');
  });

  it('verifies and returns cursor when signing is active with valid cursor', async () => {
    const { signCursor } = await import('../../src/lib/signing');
    const secret = 'test-secret-32-chars-long-xxxxxxx';
    const signed = signCursor('page-2', secret);
    const signing = { config: { cursors: true }, secret };
    const result = parseCursorParams({ cursor: signed }, undefined, signing as any);
    expect(result.cursor).toBe('page-2');
    expect(result.invalidCursor).toBeUndefined();
  });

  it('returns invalidCursor:true when signed cursor is tampered', () => {
    const signing = { config: { cursors: true }, secret: 'test-secret-32-chars-long-xxxxxxx' };
    const result = parseCursorParams(
      { cursor: 'tampered-cursor-value' },
      undefined,
      signing as any,
    );
    expect(result.cursor).toBeUndefined();
    expect(result.invalidCursor).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybeSignCursor (lines 66-75)
// ---------------------------------------------------------------------------

describe('maybeSignCursor', () => {
  it('returns null when cursor is null', async () => {
    const { maybeSignCursor } = await import('../../src/framework/lib/pagination');
    expect(maybeSignCursor(null)).toBeNull();
  });

  it('returns cursor as-is when no signing config', async () => {
    const { maybeSignCursor } = await import('../../src/framework/lib/pagination');
    expect(maybeSignCursor('cursor-abc')).toBe('cursor-abc');
  });

  it('returns cursor as-is when signing cursors is disabled', async () => {
    const { maybeSignCursor } = await import('../../src/framework/lib/pagination');
    const signing = { config: { cursors: false }, secret: 'secret' };
    expect(maybeSignCursor('cursor-abc', signing as any)).toBe('cursor-abc');
  });

  it('returns cursor as-is when secret is null', async () => {
    const { maybeSignCursor } = await import('../../src/framework/lib/pagination');
    const signing = { config: { cursors: true }, secret: null };
    expect(maybeSignCursor('cursor-abc', signing as any)).toBe('cursor-abc');
  });

  it('returns signed cursor when signing is active', async () => {
    const { maybeSignCursor } = await import('../../src/framework/lib/pagination');
    const { verifyCursor } = await import('../../src/lib/signing');
    const secret = 'test-secret-32-chars-long-xxxxxxx';
    const signing = { config: { cursors: true }, secret };
    const signed = maybeSignCursor('page-3', signing as any);
    expect(typeof signed).toBe('string');
    expect(verifyCursor(signed ?? '', secret)).toBe('page-3');
  });
});
