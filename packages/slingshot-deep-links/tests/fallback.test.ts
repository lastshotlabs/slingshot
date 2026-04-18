/**
 * Tests for expandFallback path pattern expansion.
 */
import { describe, expect, test } from 'bun:test';
import { expandFallback } from '../src/fallback';

describe('expandFallback — basic matching', () => {
  test('substitutes :id with tail for /share/* → /posts/:id', () => {
    const result = expandFallback('/share/*', '/posts/:id', '/share/123');
    expect(result).toBe('/posts/123');
  });

  test('returns null when path does not start with prefix', () => {
    expect(expandFallback('/share/*', '/posts/:id', '/other/123')).toBeNull();
  });

  test('returns null when tail is empty (exact prefix match)', () => {
    expect(expandFallback('/share/*', '/posts/:id', '/share/')).toBeNull();
  });

  test('returns target as-is when no :id placeholder', () => {
    const result = expandFallback('/old/*', '/new', '/old/anything');
    expect(result).toBe('/new');
  });
});

describe('expandFallback — various patterns', () => {
  test('root wildcard /* → /app/:id', () => {
    const result = expandFallback('/*', '/app/:id', '/some-path');
    expect(result).toBe('/app/some-path');
  });

  test('nested prefix /a/b/* → /x/:id', () => {
    const result = expandFallback('/a/b/*', '/x/:id', '/a/b/123');
    expect(result).toBe('/x/123');
  });

  test('preserves path with slashes in tail', () => {
    // tail is everything after the prefix — may include slashes
    const result = expandFallback('/share/*', '/posts/:id', '/share/foo/bar');
    expect(result).toBe('/posts/foo/bar');
  });

  test('returns null for path missing the wildcard prefix segment', () => {
    expect(expandFallback('/docs/*', '/help/:id', '/documentation/1')).toBeNull();
  });
});
