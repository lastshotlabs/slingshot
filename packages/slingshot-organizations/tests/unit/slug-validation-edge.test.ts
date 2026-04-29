import { describe, expect, test } from 'bun:test';
import {
  assertValidOrgSlug,
  createOrgSlugSchema,
} from '../../src/lib/slugValidation';
import { ZodError } from 'zod';

describe('slug validation edge cases', () => {
  const schema = createOrgSlugSchema();

  // -------------------------------------------------------------------------
  // Boundary / edge-case slugs
  // -------------------------------------------------------------------------

  test('single character slug "a" is valid', () => {
    expect(schema.parse('a')).toBe('a');
  });

  test('two-character slug is valid', () => {
    expect(schema.parse('ab')).toBe('ab');
  });

  test('slug containing only digits is valid', () => {
    expect(schema.parse('123')).toBe('123');
    expect(schema.parse('42')).toBe('42');
  });

  test('slug starting with a digit is valid', () => {
    expect(schema.parse('1abc')).toBe('1abc');
  });

  test('slug exactly 63 characters is valid', () => {
    const slug = 'a' + 'b'.repeat(61) + 'c';
    expect(slug.length).toBe(63);
    expect(schema.parse(slug)).toBe(slug);
  });

  test('slug over 63 characters is rejected', () => {
    const slug = 'a' + 'b'.repeat(62) + 'c';
    expect(slug.length).toBe(64);
    expect(() => schema.parse(slug)).toThrow();
  });

  // -------------------------------------------------------------------------
  // Rejected patterns
  // -------------------------------------------------------------------------

  test('dashes are valid within slugs (the pattern allows consecutive dashes)', () => {
    // The regex pattern allows consecutive dashes since `[a-z0-9-]` includes the dash
    // without restriction on repetition. Consecutive dashes are syntactically valid.
    expect(schema.parse('a--b')).toBe('a--b');
    expect(schema.parse('a---b')).toBe('a---b');
  });

  test('unicode characters are rejected', () => {
    expect(() => schema.parse('café')).toThrow(/DNS-safe/);
    expect(() => schema.parse('中文')).toThrow(/DNS-safe/);
    expect(() => schema.parse('русский')).toThrow(/DNS-safe/);
  });

  test('special characters beyond dash are rejected', () => {
    expect(() => schema.parse('foo_bar')).toThrow(/DNS-safe/);
    expect(() => schema.parse('foo.bar')).toThrow(/DNS-safe/);
    expect(() => schema.parse('foo/bar')).toThrow(/DNS-safe/);
    expect(() => schema.parse('foo%bar')).toThrow(/DNS-safe/);
    expect(() => schema.parse('foo bar')).toThrow(/DNS-safe/);
    expect(() => schema.parse('foo#bar')).toThrow(/DNS-safe/);
  });

  test('string with only whitespace is rejected as empty or DNS-unsafe', () => {
    // Whitespace-only strings get trimmed by some inputs but not by the regex
    expect(() => schema.parse('   ')).toThrow();
  });

  test('empty string is rejected', () => {
    expect(() => schema.parse('')).toThrow(/must not be empty/i);
  });

  // -------------------------------------------------------------------------
  // assertValidOrgSlug additional edge cases
  // -------------------------------------------------------------------------

  test('assertValidOrgSlug throws on non-string input', () => {
    // assertValidOrgSlug calls createOrgSlugSchema().parse(slug) which
    // throws ZodError for non-string values
    expect(() => assertValidOrgSlug(null)).toThrow(ZodError);
    expect(() => assertValidOrgSlug(undefined)).toThrow(ZodError);
    expect(() => assertValidOrgSlug(42)).toThrow(ZodError);
    expect(() => assertValidOrgSlug({})).toThrow(ZodError);
    expect(() => assertValidOrgSlug([])).toThrow(ZodError);
  });

  test('assertValidOrgSlug passes a valid slug through unchanged', () => {
    expect(assertValidOrgSlug('my-org')).toBe('my-org');
    expect(assertValidOrgSlug('a')).toBe('a');
    expect(assertValidOrgSlug('123-abc')).toBe('123-abc');
  });

  // -------------------------------------------------------------------------
  // Reserved-word checks (case-insensitive)
  // -------------------------------------------------------------------------

  test('reserved word check is case-insensitive', () => {
    // 'admin' is reserved; all variants should be rejected
    expect(() => schema.parse('Admin')).toThrow(/reserved/);
    expect(() => schema.parse('ADMIN')).toThrow(/reserved/);
    expect(() => schema.parse('Admin')).toThrow(/reserved/);
  });

  test('custom reserved list with empty entries is handled gracefully', () => {
    const customSchema = createOrgSlugSchema(['', ' admin ']);
    // Empty string in reserved list after trim should catch empty slug
    // 'admin' (after trimming lowercasing) is reserved
    expect(() => customSchema.parse('admin')).toThrow(/reserved/);
  });

  test('custom reserved list disables DEFAULT reserved words', () => {
    const customSchema = createOrgSlugSchema(['custom-blocked']);
    expect(() => customSchema.parse('custom-blocked')).toThrow(/reserved/);
    // 'admin' should no longer be reserved
    expect(customSchema.parse('admin')).toBe('admin');
  });

  test('empty reserved list permits all words including default reserved ones', () => {
    const noReserved = createOrgSlugSchema([]);
    expect(noReserved.parse('admin')).toBe('admin');
    expect(noReserved.parse('api')).toBe('api');
    expect(noReserved.parse('www')).toBe('www');
  });

  // -------------------------------------------------------------------------
  // Slug with dashes
  // -------------------------------------------------------------------------

  test('single internal dash is valid', () => {
    expect(schema.parse('my-org')).toBe('my-org');
    expect(schema.parse('a-b')).toBe('a-b');
  });

  test('trailing dash is rejected', () => {
    expect(() => schema.parse('myorg-')).toThrow(/DNS-safe/);
    expect(() => schema.parse('a-')).toThrow(/DNS-safe/);
  });

  test('leading dash is rejected', () => {
    expect(() => schema.parse('-myorg')).toThrow(/DNS-safe/);
    expect(() => schema.parse('-a')).toThrow(/DNS-safe/);
  });

  test('a lone dash is rejected', () => {
    expect(() => schema.parse('-')).toThrow(/DNS-safe/);
  });

  test('multiple internal single dashes are valid', () => {
    expect(schema.parse('a-b-c-d')).toBe('a-b-c-d');
  });
});
