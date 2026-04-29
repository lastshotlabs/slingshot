// packages/slingshot-orchestration-plugin/tests/resolver-error.test.ts
//
// Unit tests for InvalidResolverResultError — the typed error thrown when
// resolveRequestContext() returns a value that violates the contract
// (non-object, or fields with wrong types).
import { describe, expect, test } from 'bun:test';
import { InvalidResolverResultError } from '../src/errors';

describe('InvalidResolverResultError — class mechanics', () => {
  test('extends Error', () => {
    const err = new InvalidResolverResultError('test detail');
    expect(err).toBeInstanceOf(Error);
  });

  test('has the correct code property (INVALID_RESOLVER_RESULT)', () => {
    const err = new InvalidResolverResultError('test detail');
    expect(err.code).toBe('INVALID_RESOLVER_RESULT');
  });

  test('has the correct name property', () => {
    const err = new InvalidResolverResultError('test detail');
    expect(err.name).toBe('InvalidResolverResultError');
  });

  test('is not an instance of TypeError (avoids catching generic type errors)', () => {
    const err = new InvalidResolverResultError('test');
    expect(err).not.toBeInstanceOf(TypeError);
  });

  test('has a stack trace', () => {
    const err = new InvalidResolverResultError('test');
    expect(typeof err.stack).toBe('string');
  });

  test('can be thrown and caught by type', () => {
    let caught: unknown;
    try {
      throw new InvalidResolverResultError('oops');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidResolverResultError);
  });
});

describe('InvalidResolverResultError — message format', () => {
  test('formats message with standard prefix followed by detail', () => {
    const err = new InvalidResolverResultError('expected an object');
    expect(err.message).toBe('Invalid resolveRequestContext result: expected an object');
  });

  test('includes detail when it is a longer description', () => {
    const err = new InvalidResolverResultError('tenantId must be a string when provided');
    expect(err.message).toBe(
      'Invalid resolveRequestContext result: tenantId must be a string when provided',
    );
  });

  test('handles detail strings with colons and special characters', () => {
    const err = new InvalidResolverResultError('field "x" is wrong: got number');
    expect(err.message).toContain('got number');
  });

  test('every validation error from the routes file produces matching error message', () => {
    // These are the exact detail strings used in routes.ts resolveRequestContext().
    const detailToExpected = [
      ['expected an object, null, or undefined', 'expected an object, null, or undefined'],
      ['tenantId must be a string when provided', 'tenantId must be a string when provided'],
      ['actorId must be a string when provided', 'actorId must be a string when provided'],
      ['tags must be an object when provided', 'tags must be an object when provided'],
      ['metadata must be an object when provided', 'metadata must be an object when provided'],
    ] as const;

    for (const [detail, expectedDetail] of detailToExpected) {
      const err = new InvalidResolverResultError(detail);
      expect(err.message).toBe(`Invalid resolveRequestContext result: ${expectedDetail}`);
    }
  });
});

describe('InvalidResolverResultError — instanceof and type narrowing', () => {
  test('instanceof check works after catching as Error', () => {
    try {
      throw new InvalidResolverResultError('test');
    } catch (err: unknown) {
      expect(err instanceof InvalidResolverResultError).toBe(true);
    }
  });

  test('instanceof Error passes', () => {
    const err = new InvalidResolverResultError('test');
    expect(err instanceof Error).toBe(true);
  });

  test('error.code is accessible after narrowing from unknown', () => {
    try {
      throw new InvalidResolverResultError('test');
    } catch (err: unknown) {
      if (err instanceof InvalidResolverResultError) {
        expect(err.code).toBe('INVALID_RESOLVER_RESULT');
      } else {
        expect.unreachable('err should be InvalidResolverResultError');
      }
    }
  });
});
