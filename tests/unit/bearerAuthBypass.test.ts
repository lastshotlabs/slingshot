import { describe, expect, test } from 'bun:test';

// Test the bypass logic in isolation — copy the predicate so we can unit-test it
// without spinning up a full Hono app.
function isBypassed(path: string, bypassList: string[]): boolean {
  return bypassList.some(entry =>
    entry.endsWith('*') ? path.startsWith(entry.slice(0, -1)) : path === entry,
  );
}

const DEFAULT_BYPASS = ['/docs', '/openapi.json', '/sw.js', '/health', '/', '/metrics'];

describe('bearer auth bypass — exact match', () => {
  test('exact path matches', () => {
    expect(isBypassed('/health', DEFAULT_BYPASS)).toBe(true);
    expect(isBypassed('/docs', DEFAULT_BYPASS)).toBe(true);
    expect(isBypassed('/', DEFAULT_BYPASS)).toBe(true);
  });

  test('non-matching path is rejected', () => {
    expect(isBypassed('/api/users', DEFAULT_BYPASS)).toBe(false);
    expect(isBypassed('/healthz', DEFAULT_BYPASS)).toBe(false);
  });
});

describe('bearer auth bypass — prefix match', () => {
  const withPrefix = [...DEFAULT_BYPASS, '/scim/v2/*', '/.well-known/*'];

  test('prefix entry matches sub-paths', () => {
    expect(isBypassed('/scim/v2/Users', withPrefix)).toBe(true);
    expect(isBypassed('/scim/v2/Users/abc123', withPrefix)).toBe(true);
    expect(isBypassed('/.well-known/openid-configuration', withPrefix)).toBe(true);
    expect(isBypassed('/.well-known/jwks.json', withPrefix)).toBe(true);
  });

  test('prefix entry does not match unrelated paths', () => {
    expect(isBypassed('/scim/v3/Users', withPrefix)).toBe(false);
    expect(isBypassed('/other/.well-known/jwks.json', withPrefix)).toBe(false);
  });

  test('exact entries in same list still work', () => {
    expect(isBypassed('/health', withPrefix)).toBe(true);
    expect(isBypassed('/api/data', withPrefix)).toBe(false);
  });
});
