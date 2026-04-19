import { describe, expect, test } from 'bun:test';
import { routeKey, shouldMountRoute } from '../../src/routeOverrides';

describe('routeKey', () => {
  test('uppercases the method and joins with path', () => {
    expect(routeKey('get', '/items')).toBe('GET /items');
  });

  test('preserves already-uppercased method', () => {
    expect(routeKey('POST', '/items')).toBe('POST /items');
  });

  test('preserves mixed-case method by uppercasing', () => {
    expect(routeKey('Delete', '/items/:id')).toBe('DELETE /items/:id');
  });

  test('handles path with query-like segments', () => {
    expect(routeKey('get', '/search?q=test')).toBe('GET /search?q=test');
  });

  test('handles root path', () => {
    expect(routeKey('get', '/')).toBe('GET /');
  });
});

describe('shouldMountRoute', () => {
  test('returns true when disabledRoutes is undefined', () => {
    expect(shouldMountRoute('GET', '/items')).toBe(true);
  });

  test('returns true when disabledRoutes is an empty array', () => {
    expect(shouldMountRoute('GET', '/items', [])).toBe(true);
  });

  test('returns true when route is not in disabledRoutes', () => {
    const disabled = [routeKey('DELETE', '/items/:id')];
    expect(shouldMountRoute('GET', '/items', disabled)).toBe(true);
  });

  test('returns false when route is in disabledRoutes', () => {
    const disabled = [routeKey('GET', '/items'), routeKey('POST', '/items')];
    expect(shouldMountRoute('GET', '/items', disabled)).toBe(false);
  });

  test('matching is case-insensitive on method because routeKey uppercases', () => {
    const disabled = [routeKey('GET', '/items')];
    // shouldMountRoute internally calls routeKey which uppercases, so 'get' matches 'GET'
    expect(shouldMountRoute('get', '/items', disabled)).toBe(false);
  });

  test('returns true for a different method on the same path', () => {
    const disabled = [routeKey('POST', '/items')];
    expect(shouldMountRoute('GET', '/items', disabled)).toBe(true);
  });

  test('returns true for same method but different path', () => {
    const disabled = [routeKey('GET', '/items')];
    expect(shouldMountRoute('GET', '/items/:id', disabled)).toBe(true);
  });
});
