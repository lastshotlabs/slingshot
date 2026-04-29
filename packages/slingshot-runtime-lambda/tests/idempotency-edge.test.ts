import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../src/idempotency';

describe('IdempotencyConflictError', () => {
  test('has correct name', () => {
    const err = new IdempotencyConflictError('key conflict');
    expect(err.name).toBe('IdempotencyConflictError');
  });

  test('is instance of Error', () => {
    const err = new IdempotencyConflictError('oops');
    expect(err).toBeInstanceOf(Error);
  });

  test('contains the message', () => {
    const err = new IdempotencyConflictError('duplicate key: abc123');
    expect(err.message).toBe('duplicate key: abc123');
  });

  test('can be caught with instanceof', () => {
    try {
      throw new IdempotencyConflictError('test conflict');
    } catch (e) {
      expect(e instanceof IdempotencyConflictError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });

  test('can be discriminated from regular Error', () => {
    const idemErr = new IdempotencyConflictError('conflict');
    const regErr = new Error('generic error');
    expect(idemErr instanceof IdempotencyConflictError).toBe(true);
    expect(regErr instanceof IdempotencyConflictError).toBe(false);
  });
});
