import { describe, expect, test } from 'bun:test';
import { HttpError } from '@lastshotlabs/slingshot-core';

describe('HttpError', () => {
  test('sets status and message', () => {
    const err = new HttpError(404, 'Not Found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not Found');
  });

  test('extends Error', () => {
    const err = new HttpError(500, 'Server Error');
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct name', () => {
    const err = new HttpError(400, 'Bad Request');
    expect(err.name).toBe('Error');
  });
});

describe('HttpError — code field', () => {
  test('code is undefined when not provided', () => {
    const err = new HttpError(404, 'Not Found');
    expect(err.code).toBeUndefined();
  });

  test('code is set when provided', () => {
    const err = new HttpError(403, 'Forbidden', 'ACCOUNT_SUSPENDED');
    expect(err.code).toBe('ACCOUNT_SUSPENDED');
  });

  test('status and message still work with code', () => {
    const err = new HttpError(401, 'Unauthorized', 'FINGERPRINT_MISMATCH');
    expect(err.status).toBe(401);
    expect(err.message).toBe('Unauthorized');
    expect(err.code).toBe('FINGERPRINT_MISMATCH');
  });
});
