import { describe, expect, test } from 'bun:test';
import { encodeCursor, decodeCursor } from '../../src/cursor';

describe('encodeCursor', () => {
  test('returns a base64-encoded JSON string', () => {
    const payload = { id: 'abc', createdAt: '2024-01-01' };
    const cursor = encodeCursor(payload);
    // Decode manually and verify round-trip
    const decoded = JSON.parse(atob(cursor));
    expect(decoded).toEqual(payload);
  });

  test('handles empty object', () => {
    const cursor = encodeCursor({});
    expect(JSON.parse(atob(cursor))).toEqual({});
  });

  test('handles nested objects', () => {
    const payload = { meta: { page: 2, filters: [1, 2, 3] } };
    const cursor = encodeCursor(payload);
    expect(JSON.parse(atob(cursor))).toEqual(payload);
  });

  test('is deterministic for the same input', () => {
    const payload = { id: '123' };
    expect(encodeCursor(payload)).toBe(encodeCursor(payload));
  });
});

describe('decodeCursor', () => {
  test('decodes a valid cursor back to its payload', () => {
    const payload = { id: 'msg_123', createdAt: '2024-01-01T00:00:00Z' };
    const cursor = encodeCursor(payload);
    const result = decodeCursor<typeof payload>(cursor);
    expect(result).toEqual(payload);
  });

  test('returns null for invalid base64', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });

  test('returns null for valid base64 that is not JSON', () => {
    const notJson = btoa('this is not json');
    expect(decodeCursor(notJson)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });

  test('passes decoded value through validate guard', () => {
    const payload = { id: 'abc', seq: 42 };
    const cursor = encodeCursor(payload);
    const guard = (v: unknown): v is typeof payload => {
      const obj = v as Record<string, unknown>;
      return typeof obj?.id === 'string' && typeof obj?.seq === 'number';
    };
    const result = decodeCursor(cursor, guard);
    expect(result).toEqual(payload);
  });

  test('returns null when validate guard fails', () => {
    const payload = { id: 'abc', seq: 'not-a-number' };
    const cursor = encodeCursor(payload);
    const guard = (v: unknown): v is { id: string; seq: number } => {
      const obj = v as Record<string, unknown>;
      return typeof obj?.id === 'string' && typeof obj?.seq === 'number';
    };
    const result = decodeCursor(cursor, guard);
    expect(result).toBeNull();
  });

  test('returns payload when no validate guard is provided', () => {
    const payload = { foo: 'bar' };
    const cursor = encodeCursor(payload);
    const result = decodeCursor(cursor);
    expect(result).toEqual(payload);
  });

  test('round-trips with complex payload', () => {
    const payload = { ts: 1704067200000, id: 'x'.repeat(100), flag: true };
    const cursor = encodeCursor(payload);
    const result = decodeCursor<typeof payload>(cursor);
    expect(result).toEqual(payload);
  });
});
