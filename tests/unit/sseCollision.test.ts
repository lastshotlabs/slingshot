import { describe, expect, test } from 'bun:test';
import { routePatternCanMatchLiteral } from '../../src/framework/sse/collision';

describe('routePatternCanMatchLiteral', () => {
  test('catch-all /* matches any path', () => {
    expect(routePatternCanMatchLiteral('/*', '/__sse/feed')).toBe(true);
  });

  test('prefix wildcard /__sse/* matches /__sse/feed', () => {
    expect(routePatternCanMatchLiteral('/__sse/*', '/__sse/feed')).toBe(true);
  });

  test(':param segment matches /__sse/feed', () => {
    expect(routePatternCanMatchLiteral('/__sse/:id', '/__sse/feed')).toBe(true);
  });

  test('exact match', () => {
    expect(routePatternCanMatchLiteral('/__sse/feed', '/__sse/feed')).toBe(true);
  });

  test('/users/:id does not match /__sse/feed', () => {
    expect(routePatternCanMatchLiteral('/users/:id', '/__sse/feed')).toBe(false);
  });

  test('/api/v1 does not match /__sse/api/v1', () => {
    expect(routePatternCanMatchLiteral('/api/v1', '/__sse/api/v1')).toBe(false);
  });

  test('/api/* does not match /__sse/api/v1', () => {
    expect(routePatternCanMatchLiteral('/api/*', '/__sse/api/v1')).toBe(false);
  });
});
