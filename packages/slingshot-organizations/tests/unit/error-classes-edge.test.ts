import { describe, expect, test } from 'bun:test';
import { SlugConflictError, isUniqueViolationError } from '../../src/errors';

describe('SlugConflictError', () => {
  test('extends HTTPException', () => {
    const err = new SlugConflictError('my-org', 'organization');
    expect(err).toBeInstanceOf(Error);
  });

  test('carries slug and entity type', () => {
    const err = new SlugConflictError(
      'my-org-slug',
      "organization slug 'my-org-slug' is already in use",
    );
    expect(err.message).toContain('my-org-slug');
    expect(err.message).toContain('organization');
  });

  test('has status 409', () => {
    const err = new SlugConflictError('test', "group slug 'test' is already in use");
    expect(err.status).toBe(409);
  });

  test('different entity types produce different messages', () => {
    const orgErr = new SlugConflictError('slug', "organization slug 'slug' is already in use");
    const groupErr = new SlugConflictError('slug', "group slug 'slug' is already in use");
    expect(orgErr.message).not.toBe(groupErr.message);
  });
});

describe('isUniqueViolationError', () => {
  test('returns true for 23505 code', () => {
    const err = Object.assign(new Error('unique violation'), { code: '23505' });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('returns false for other codes', () => {
    const err = Object.assign(new Error('other error'), { code: '42P01' });
    expect(isUniqueViolationError(err)).toBe(false);
  });

  test('returns false for errors without code', () => {
    const err = new Error('generic');
    expect(isUniqueViolationError(err)).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isUniqueViolationError(null)).toBe(false);
    expect(isUniqueViolationError(undefined)).toBe(false);
  });

  test('handles Drizzle-wrapped errors', () => {
    const cause = Object.assign(new Error('unique violation'), { code: '23505' });
    const wrapped = new Error('query failed');
    (wrapped as any).cause = cause;
    expect(isUniqueViolationError(wrapped)).toBe(true);
  });
});
