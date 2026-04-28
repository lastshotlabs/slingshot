// packages/slingshot-core/tests/safePath.test.ts
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { PathTraversalError, safeJoin } from '../src/lib/safePath';

const BASE = '/var/data/slingshot';

describe('safeJoin', () => {
  test('joins a simple relative path under base', () => {
    expect(safeJoin(BASE, 'foo/bar.txt')).toBe(path.resolve(BASE, 'foo/bar.txt'));
  });

  test('returns the base directory itself for an empty relative path', () => {
    expect(safeJoin(BASE, '')).toBe(path.resolve(BASE));
    expect(safeJoin(BASE, '.')).toBe(path.resolve(BASE));
  });

  test('rejects path-traversal via .. segments', () => {
    expect(() => safeJoin(BASE, '../etc/passwd')).toThrow(PathTraversalError);
    expect(() => safeJoin(BASE, '../../etc/passwd')).toThrow(PathTraversalError);
    expect(() => safeJoin(BASE, 'foo/../../etc/passwd')).toThrow(PathTraversalError);
  });

  test('allows .. that stays within the base', () => {
    expect(safeJoin(BASE, 'foo/../bar')).toBe(path.resolve(BASE, 'bar'));
  });

  test('rejects absolute path inputs that escape base', () => {
    expect(() => safeJoin(BASE, '/etc/passwd')).toThrow(PathTraversalError);
  });

  test('rejects null bytes', () => {
    expect(() => safeJoin(BASE, 'foo\0bar')).toThrow(PathTraversalError);
    expect(() => safeJoin(BASE, '\0')).toThrow(PathTraversalError);
  });

  test('rejects non-string inputs', () => {
    // @ts-expect-error — runtime guard
    expect(() => safeJoin(BASE, 42)).toThrow(PathTraversalError);
    // @ts-expect-error — runtime guard
    expect(() => safeJoin(BASE, undefined)).toThrow(PathTraversalError);
    // @ts-expect-error — runtime guard
    expect(() => safeJoin(BASE, null)).toThrow(PathTraversalError);
  });

  test('error message names the offending input', () => {
    try {
      safeJoin(BASE, '../etc/passwd');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PathTraversalError);
      expect((err as Error).message).toContain('../etc/passwd');
    }
  });

  test('PathTraversalError has correct name', () => {
    try {
      safeJoin(BASE, '../x');
    } catch (err) {
      expect((err as Error).name).toBe('PathTraversalError');
    }
  });
});
