import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import {
  SLUG_CONFLICT_CODE,
  SlugConflictError,
  isUniqueViolationError,
} from '../../src/errors';

describe('SlugConflictError', () => {
  test('extends HTTPException which extends Error', () => {
    const err = new SlugConflictError('test-slug');
    expect(err).toBeInstanceOf(HTTPException);
    expect(err).toBeInstanceOf(Error);
  });

  test('sets name to SlugConflictError', () => {
    const err = new SlugConflictError('test-slug');
    expect(err.name).toBe('SlugConflictError');
  });

  test('uses slug to derive default message when no custom message given', () => {
    const err = new SlugConflictError('my-slug');
    expect(err.message).toContain('my-slug');
    expect(err.message).toMatch(/already in use/i);
  });

  test('accepts a custom message that overrides the default', () => {
    const err = new SlugConflictError('slug', 'custom error text');
    expect(err.message).toBe('custom error text');
  });

  test('response body includes error, SLUG_CONFLICT code, and the conflicting slug', async () => {
    const err = new SlugConflictError('conflicting-slug');
    const res = err.getResponse();
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = JSON.parse(await res.text());
    expect(body).toEqual({
      error: "Slug 'conflicting-slug' is already in use",
      code: SLUG_CONFLICT_CODE,
      slug: 'conflicting-slug',
    });
  });

  test('response body uses custom message when provided', async () => {
    const err = new SlugConflictError('slug', 'org slug is already taken');
    const body = JSON.parse(await err.getResponse().text());
    expect(body.error).toBe('org slug is already taken');
  });

  test('static CODE property matches exported constant', () => {
    expect(SlugConflictError.CODE).toBe(SLUG_CONFLICT_CODE);
  });

  test('the code instance property matches the static CODE', () => {
    const err = new SlugConflictError('slug');
    expect(err.code).toBe(SlugConflictError.CODE);
  });
});

describe('isUniqueViolationError', () => {
  test('returns false for null and undefined', () => {
    expect(isUniqueViolationError(null)).toBe(false);
    expect(isUniqueViolationError(undefined)).toBe(false);
  });

  test('returns false for primitive values', () => {
    expect(isUniqueViolationError('string')).toBe(false);
    expect(isUniqueViolationError(42)).toBe(false);
    expect(isUniqueViolationError(true)).toBe(false);
  });

  test('returns false for a plain object without any relevant fields', () => {
    expect(isUniqueViolationError({})).toBe(false);
    expect(isUniqueViolationError({ foo: 'bar' })).toBe(false);
  });

  test('returns false for an Error with an unrelated message', () => {
    expect(isUniqueViolationError(new Error('something went wrong'))).toBe(false);
    expect(isUniqueViolationError(new Error('CONNECTION_REFUSED'))).toBe(false);
    expect(isUniqueViolationError(new Error('permission denied'))).toBe(false);
  });

  test('does not match a SlugConflictError (already converted)', () => {
    expect(isUniqueViolationError(new SlugConflictError('x'))).toBe(false);
  });

  test('matches error with code UNIQUE_VIOLATION (in-memory adapter)', () => {
    const err = Object.assign(new Error('unique violation'), { code: 'UNIQUE_VIOLATION' });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches error with code 23505 (Postgres unique_violation SQLSTATE)', () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches error with numeric code 11000 (MongoDB duplicate key)', () => {
    const err = Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches generic message containing "unique" (case-insensitive)', () => {
    expect(isUniqueViolationError(new Error('Unique constraint violated'))).toBe(true);
    expect(isUniqueViolationError(new Error('UNIQUE CONSTRAINT'))).toBe(true);
    expect(isUniqueViolationError(new Error('unique'))).toBe(true);
  });

  test('matches generic message containing "duplicate" (case-insensitive)', () => {
    expect(isUniqueViolationError(new Error('Duplicate entry'))).toBe(true);
    expect(isUniqueViolationError(new Error('DUPLICATE KEY'))).toBe(true);
    expect(isUniqueViolationError(new Error('duplicates found'))).toBe(true);
  });

  test('matches message with "unique constraint" exactly', () => {
    const err = new Error('unique constraint violation on field slug');
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches message with "duplicate key" exactly', () => {
    const err = new Error('duplicate key value violates unique constraint');
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('error with a non-relevant code but matching message is still detected', () => {
    const err = Object.assign(new Error('duplicate entry for key'), { code: 'ER_DUP_ENTRY' });
    // ER_DUP_ENTRY is not one of the known codes, but the message contains "duplicate"
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('error with code=0 should not match (not MongoDB 11000)', () => {
    const err = Object.assign(new Error('some error'), { code: 0 });
    expect(isUniqueViolationError(err)).toBe(false);
  });
});
