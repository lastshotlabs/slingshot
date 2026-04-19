import { describe, expect, test } from 'bun:test';
import {
  offsetParams,
  parseOffsetParams,
  paginatedResponse,
  cursorParams,
  parseCursorParams,
  cursorPaginatedResponse,
} from '../../src/pagination';
import { z } from 'zod';

describe('offsetParams', () => {
  test('returns a zod object schema with limit and offset', () => {
    const schema = offsetParams();
    const result = schema.parse({});
    expect(result).toEqual({});
  });

  test('accepts custom defaults', () => {
    const schema = offsetParams({ limit: 25, maxLimit: 100, offset: 10 });
    const result = schema.parse({});
    expect(result).toEqual({});
  });
});

describe('parseOffsetParams', () => {
  test('uses framework defaults when no params', () => {
    const result = parseOffsetParams({});
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  test('uses custom defaults', () => {
    const result = parseOffsetParams({}, { limit: 25, offset: 10 });
    expect(result).toEqual({ limit: 25, offset: 10 });
  });

  test('parses string limit and offset', () => {
    const result = parseOffsetParams({ limit: '20', offset: '5' });
    expect(result).toEqual({ limit: 20, offset: 5 });
  });

  test('clamps limit to maxLimit', () => {
    const result = parseOffsetParams({ limit: '500' }, { maxLimit: 100 });
    expect(result.limit).toBe(100);
  });

  test('clamps limit minimum to 1', () => {
    const result = parseOffsetParams({ limit: '0' });
    expect(result.limit).toBe(1);
  });

  test('clamps negative offset to 0', () => {
    const result = parseOffsetParams({ offset: '-5' });
    expect(result.offset).toBe(0);
  });

  test('NaN limit falls back to default', () => {
    const result = parseOffsetParams({ limit: 'abc' });
    expect(result.limit).toBe(50);
  });

  test('NaN offset falls back to default', () => {
    const result = parseOffsetParams({ offset: 'abc' });
    expect(result.offset).toBe(0);
  });
});

describe('paginatedResponse', () => {
  test('returns a schema with items, total, limit, offset', () => {
    const itemSchema = z.object({ id: z.string() });
    const schema = paginatedResponse(itemSchema, 'TestListResponse');
    const result = schema.parse({ items: [{ id: '1' }], total: 1, limit: 50, offset: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

describe('cursorParams', () => {
  test('returns a zod object schema with limit and cursor', () => {
    const schema = cursorParams();
    const result = schema.parse({});
    expect(result).toEqual({});
  });

  test('accepts custom defaults', () => {
    const schema = cursorParams({ limit: 25, maxLimit: 100 });
    const result = schema.parse({ limit: '10', cursor: 'abc' });
    expect(result).toEqual({ limit: '10', cursor: 'abc' });
  });
});

describe('parseCursorParams', () => {
  test('uses framework defaults when no params', () => {
    const result = parseCursorParams({});
    expect(result).toEqual({ limit: 50, cursor: undefined });
  });

  test('uses custom defaults', () => {
    const result = parseCursorParams({}, { limit: 25 });
    expect(result).toEqual({ limit: 25, cursor: undefined });
  });

  test('parses string limit and cursor', () => {
    const result = parseCursorParams({ limit: '20', cursor: 'next-token' });
    expect(result).toEqual({ limit: 20, cursor: 'next-token' });
  });

  test('clamps limit to maxLimit', () => {
    const result = parseCursorParams({ limit: '500' }, { maxLimit: 100 });
    expect(result.limit).toBe(100);
  });

  test('clamps limit minimum to 1', () => {
    const result = parseCursorParams({ limit: '-1' });
    expect(result.limit).toBe(1);
  });

  test('NaN limit falls back to default', () => {
    const result = parseCursorParams({ limit: 'nope' });
    expect(result.limit).toBe(50);
  });

  test('empty cursor string becomes undefined', () => {
    const result = parseCursorParams({ cursor: '' });
    expect(result.cursor).toBeUndefined();
  });
});

describe('cursorPaginatedResponse', () => {
  test('returns a schema with items and nextCursor', () => {
    const itemSchema = z.object({ id: z.string() });
    const schema = cursorPaginatedResponse(itemSchema, 'TestCursorResponse');
    const result = schema.parse({ items: [{ id: '1' }], nextCursor: 'abc' });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('abc');
  });
});
