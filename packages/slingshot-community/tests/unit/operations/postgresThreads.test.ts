import { describe, expect, test } from 'bun:test';
import {
  THREAD_POSTGRES_TABLE,
  clampLimit,
  parseCountRow,
  toCamelRecord,
} from '../../../src/operations/postgresThreads';

describe('postgresThreads utilities', () => {
  describe('THREAD_POSTGRES_TABLE', () => {
    test('is a string constant', () => {
      expect(typeof THREAD_POSTGRES_TABLE).toBe('string');
      expect(THREAD_POSTGRES_TABLE).toBe('slingshot_thread');
    });
  });

  describe('clampLimit', () => {
    test('returns fallback when raw is undefined', () => {
      expect(clampLimit(undefined)).toBe(20);
    });

    test('returns custom fallback when raw is undefined', () => {
      expect(clampLimit(undefined, 50)).toBe(50);
    });

    test('parses valid number strings', () => {
      expect(clampLimit('10')).toBe(10);
      expect(clampLimit('1')).toBe(1);
      expect(clampLimit('100')).toBe(100);
    });

    test('clamps to minimum of 1', () => {
      expect(clampLimit('0')).toBe(1);
      expect(clampLimit('-5')).toBe(1);
    });

    test('clamps to maximum of 100', () => {
      expect(clampLimit('200')).toBe(100);
      expect(clampLimit('999')).toBe(100);
    });

    test('returns fallback for non-numeric strings', () => {
      expect(clampLimit('abc')).toBe(20);
      expect(clampLimit('')).toBe(20);
    });
  });

  describe('parseCountRow', () => {
    test('returns numeric total directly', () => {
      expect(parseCountRow({ total: 42 })).toBe(42);
    });

    test('converts string total to number', () => {
      expect(parseCountRow({ total: '15' })).toBe(15);
    });

    test('returns 0 for undefined row', () => {
      expect(parseCountRow(undefined)).toBe(0);
    });

    test('returns 0 for missing total field', () => {
      expect(parseCountRow({})).toBe(0);
    });

    test('returns 0 for null total', () => {
      expect(parseCountRow({ total: null })).toBe(0);
    });
  });

  describe('toCamelRecord', () => {
    test('converts snake_case keys to camelCase', () => {
      const row = {
        id: '1',
        container_id: 'c1',
        created_at: '2024-01-01',
        last_activity_at: '2024-01-02',
      };
      const result = toCamelRecord(row);
      expect(result.id).toBe('1');
      expect(result.containerId).toBe('c1');
      expect(result.createdAt).toBe('2024-01-01');
      expect(result.lastActivityAt).toBe('2024-01-02');
    });

    test('preserves already camelCase keys', () => {
      const row = { id: '1', containerId: 'c1' };
      const result = toCamelRecord(row);
      expect(result.id).toBe('1');
      expect(result.containerId).toBe('c1');
    });

    test('preserves values of all types', () => {
      const row = {
        string_val: 'hello',
        num_val: 42,
        bool_val: true,
        null_val: null,
        array_val: [1, 2, 3],
      };
      const result = toCamelRecord(row);
      expect(result.stringVal).toBe('hello');
      expect(result.numVal).toBe(42);
      expect(result.boolVal).toBe(true);
      expect(result.nullVal).toBeNull();
      expect(result.arrayVal).toEqual([1, 2, 3]);
    });

    test('handles empty row', () => {
      const result = toCamelRecord({});
      expect(Object.keys(result).length).toBe(0);
    });
  });
});
