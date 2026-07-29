import { describe, expect, test } from 'bun:test';
import { encodeEntityEtag, parseEntityEtag } from '../../src/concurrency/etag';

describe('entity ETag codec', () => {
  test('round-trips the canonical strong tuple format', () => {
    const tag = encodeEntityEtag('tenant_documents', 'doc/✓', 7);
    expect(tag).toMatch(/^"slingshot\.[A-Za-z0-9_-]+"$/);
    expect(parseEntityEtag(tag)).toEqual({
      storageName: 'tenant_documents',
      id: 'doc/✓',
      version: 7,
    });
    expect(Object.isFrozen(parseEntityEtag(tag))).toBe(true);
  });

  test.each([
    '',
    '*',
    'W/"slingshot.abc"',
    '"other.abc"',
    '"slingshot.abc","slingshot.def"',
    '"slingshot.***"',
    '"slingshot.e30"',
    `"slingshot.${Buffer.from(JSON.stringify(['records', 'id', 0])).toString('base64url')}"`,
    `"slingshot.${Buffer.from(JSON.stringify(['records', 'id', 1, 'extra'])).toString('base64url')}"`,
  ])('rejects malformed or unsupported If-Match value %s', value => {
    expect(() => parseEntityEtag(value)).toThrow(TypeError);
  });

  test('rejects invalid encoder inputs', () => {
    expect(() => encodeEntityEtag('', 'id', 1)).toThrow(TypeError);
    expect(() => encodeEntityEtag('records', '', 1)).toThrow(TypeError);
    expect(() => encodeEntityEtag('records', 'id', 0)).toThrow(TypeError);
    expect(() => encodeEntityEtag('records', 'id', 1.5)).toThrow(TypeError);
  });
});
