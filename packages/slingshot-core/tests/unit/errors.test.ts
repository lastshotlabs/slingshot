import { describe, expect, test } from 'bun:test';
import { HttpError, UnsupportedAdapterFeatureError, ValidationError } from '../../src/errors';

describe('HttpError', () => {
  test('sets status, message, and code', () => {
    const err = new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Post not found');
    expect(err.code).toBe('POST_NOT_FOUND');
  });

  test('code is optional', () => {
    const err = new HttpError(500, 'Internal server error');
    expect(err.status).toBe(500);
    expect(err.message).toBe('Internal server error');
    expect(err.code).toBeUndefined();
  });

  test('is throwable and catchable', () => {
    expect(() => {
      throw new HttpError(403, 'Forbidden', 'FORBIDDEN');
    }).toThrow('Forbidden');
  });
});

describe('ValidationError', () => {
  test('is an HttpError with status 400', () => {
    const issues = [{ code: 'invalid_type', message: 'Expected string', path: ['name'] }] as any;
    const err = new ValidationError(issues);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Validation failed');
  });

  test('exposes the issues array', () => {
    const issues = [
      { code: 'invalid_type', message: 'Expected string', path: ['name'] },
      { code: 'too_small', message: 'Too short', path: ['email'] },
    ] as any;
    const err = new ValidationError(issues);
    expect(err.issues).toBe(issues);
    expect(err.issues).toHaveLength(2);
  });

  test('issues property holds the same reference passed to constructor', () => {
    const issues = [
      { code: 'invalid_type', message: 'bad', path: [] },
      { code: 'too_small', message: 'short', path: ['x'] },
    ] as any;
    const err = new ValidationError(issues);
    expect(err.issues).toBe(issues);
  });
});

describe('UnsupportedAdapterFeatureError', () => {
  test('formats message with feature and adapter name', () => {
    const err = new UnsupportedAdapterFeatureError('listSessions', 'MemoryAuthAdapter');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('listSessions is not supported by the MemoryAuthAdapter adapter');
  });

  test('sets name to UnsupportedAdapterFeatureError', () => {
    const err = new UnsupportedAdapterFeatureError('deleteAll', 'SqliteAdapter');
    expect(err.name).toBe('UnsupportedAdapterFeatureError');
  });

  test('is throwable and catchable by type', () => {
    try {
      throw new UnsupportedAdapterFeatureError('bulkInsert', 'RedisAdapter');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedAdapterFeatureError);
      expect((e as UnsupportedAdapterFeatureError).message).toBe(
        'bulkInsert is not supported by the RedisAdapter adapter',
      );
    }
  });
});
