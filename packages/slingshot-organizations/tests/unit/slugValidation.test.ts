import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RESERVED_ORG_SLUGS,
  assertValidOrgSlug,
  createOrgSlugSchema,
} from '../../src/lib/slugValidation';

describe('createOrgSlugSchema', () => {
  test('accepts simple lower-case slug', () => {
    const schema = createOrgSlugSchema();
    expect(schema.parse('acme')).toBe('acme');
    expect(schema.parse('acme-corp')).toBe('acme-corp');
    expect(schema.parse('a1b2c3')).toBe('a1b2c3');
  });

  test('rejects empty slug', () => {
    const schema = createOrgSlugSchema();
    expect(() => schema.parse('')).toThrow();
  });

  test('rejects uppercase characters', () => {
    const schema = createOrgSlugSchema();
    expect(() => schema.parse('Acme')).toThrow(/DNS-safe/);
    expect(() => schema.parse('ACME')).toThrow(/DNS-safe/);
  });

  test('rejects underscores and other special chars', () => {
    const schema = createOrgSlugSchema();
    expect(() => schema.parse('acme_corp')).toThrow(/DNS-safe/);
    expect(() => schema.parse('acme.corp')).toThrow(/DNS-safe/);
    expect(() => schema.parse('acme corp')).toThrow(/DNS-safe/);
    expect(() => schema.parse('acme!')).toThrow(/DNS-safe/);
  });

  test('rejects leading and trailing dashes', () => {
    const schema = createOrgSlugSchema();
    expect(() => schema.parse('-acme')).toThrow(/DNS-safe/);
    expect(() => schema.parse('acme-')).toThrow(/DNS-safe/);
    expect(() => schema.parse('-')).toThrow(/DNS-safe/);
  });

  test('accepts slugs up to 63 characters', () => {
    const schema = createOrgSlugSchema();
    const sixtyThree = 'a' + 'b'.repeat(61) + 'c';
    expect(sixtyThree.length).toBe(63);
    expect(schema.parse(sixtyThree)).toBe(sixtyThree);
  });

  test('rejects slugs over 63 characters', () => {
    const schema = createOrgSlugSchema();
    const sixtyFour = 'a' + 'b'.repeat(62) + 'c';
    expect(sixtyFour.length).toBe(64);
    expect(() => schema.parse(sixtyFour)).toThrow();
  });

  test('rejects all default reserved words case-insensitively', () => {
    const schema = createOrgSlugSchema();
    for (const reserved of DEFAULT_RESERVED_ORG_SLUGS) {
      expect(() => schema.parse(reserved)).toThrow(/reserved/);
    }
  });

  test('accepts custom reserved-words list', () => {
    const schema = createOrgSlugSchema(['blocked']);
    expect(() => schema.parse('blocked')).toThrow(/reserved/);
    // 'admin' is no longer reserved with this list
    expect(schema.parse('admin')).toBe('admin');
  });

  test('empty reserved list disables the check', () => {
    const schema = createOrgSlugSchema([]);
    expect(schema.parse('admin')).toBe('admin');
    expect(schema.parse('api')).toBe('api');
  });

  test('rejects single dash and short edge cases properly', () => {
    const schema = createOrgSlugSchema();
    expect(schema.parse('a')).toBe('a');
    expect(() => schema.parse('-')).toThrow();
  });
});

describe('assertValidOrgSlug', () => {
  test('returns the validated slug', () => {
    expect(assertValidOrgSlug('valid-slug')).toBe('valid-slug');
  });

  test('throws on invalid slug', () => {
    expect(() => assertValidOrgSlug('Invalid-Slug')).toThrow();
    expect(() => assertValidOrgSlug('admin')).toThrow();
  });
});
