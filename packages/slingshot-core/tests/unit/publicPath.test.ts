import { describe, expect, test } from 'bun:test';
import { isPublicPath } from '../../src/publicPath';

describe('isPublicPath', () => {
  test('returns false when publicPaths is undefined', () => {
    expect(isPublicPath('/some/path')).toBe(false);
  });

  test('returns false when publicPaths is null', () => {
    expect(isPublicPath('/some/path', null)).toBe(false);
  });

  test('matches exact path', () => {
    const paths = new Set(['/.well-known/assetlinks.json']);
    expect(isPublicPath('/.well-known/assetlinks.json', paths)).toBe(true);
  });

  test('does not match different exact path', () => {
    const paths = new Set(['/api/health']);
    expect(isPublicPath('/api/status', paths)).toBe(false);
  });

  test('matches prefix wildcard pattern', () => {
    const paths = new Set(['/.well-known/*']);
    expect(isPublicPath('/.well-known/apple-app-site-association', paths)).toBe(true);
    expect(isPublicPath('/.well-known/assetlinks.json', paths)).toBe(true);
  });

  test('prefix wildcard matches the prefix itself (without trailing segment)', () => {
    const paths = new Set(['/public/*']);
    // '/public/' starts with '/public/' (the prefix minus the *), so it matches
    expect(isPublicPath('/public/', paths)).toBe(true);
  });

  test('prefix wildcard does not match unrelated paths', () => {
    const paths = new Set(['/api/*']);
    expect(isPublicPath('/other/path', paths)).toBe(false);
  });

  test('handles multiple patterns (mix of exact and wildcard)', () => {
    const paths = new Set(['/health', '/api/public/*', '/.well-known/*']);
    expect(isPublicPath('/health', paths)).toBe(true);
    expect(isPublicPath('/api/public/docs', paths)).toBe(true);
    expect(isPublicPath('/.well-known/openid-configuration', paths)).toBe(true);
    expect(isPublicPath('/api/private/data', paths)).toBe(false);
  });

  test('returns false for empty iterable', () => {
    expect(isPublicPath('/any', new Set())).toBe(false);
    expect(isPublicPath('/any', [])).toBe(false);
  });

  test('works with array as iterable', () => {
    const paths = ['/health', '/api/*'];
    expect(isPublicPath('/health', paths)).toBe(true);
    expect(isPublicPath('/api/users', paths)).toBe(true);
    expect(isPublicPath('/other', paths)).toBe(false);
  });

  test('exact match does not do prefix matching', () => {
    const paths = new Set(['/api']);
    expect(isPublicPath('/api', paths)).toBe(true);
    expect(isPublicPath('/api/extra', paths)).toBe(false);
  });

  test('wildcard pattern requires the prefix to match from the start', () => {
    const paths = new Set(['/api/*']);
    expect(isPublicPath('/not/api/test', paths)).toBe(false);
  });
});
