import { describe, expect, test } from 'bun:test';
import {
  HttpError,
  ValidationError,
  isHttpError,
  isValidationError,
} from '../../packages/slingshot-core/src/index.ts';
import { createApp } from '../../src/app';

// Regression for the "401/404 renders as 500 under Node" bug.
//
// Root cause: the app-level `onError` handler classified errors with
// `instanceof HttpError`. When the same module is loaded twice in a process
// (Node's ESM/CJS dual-instance hazard, or duplicate installs), an `HttpError`
// thrown by one copy is NOT `instanceof` the `HttpError` class imported by the
// error handler — so a genuine 401 fell through to a generic 500.
//
// We simulate the second copy with a class that brands itself via the SAME
// global registry symbol (`Symbol.for`) but is a distinct constructor — exactly
// what a duplicate module instance produces. `instanceof HttpError` is false for
// it; the brand-based guards must still recognize it.

const HTTP_ERROR_BRAND = Symbol.for('@lastshotlabs/slingshot.HttpError');
const VALIDATION_ERROR_BRAND = Symbol.for('@lastshotlabs/slingshot.ValidationError');

/** Stand-in for an `HttpError` from a *different* loaded copy of slingshot-core. */
class ForeignHttpError extends Error {
  readonly [HTTP_ERROR_BRAND] = true;
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

class ForeignValidationError extends ForeignHttpError {
  readonly [VALIDATION_ERROR_BRAND] = true;
  constructor(public issues: unknown[]) {
    super(400, 'Validation failed');
  }
}

describe('HttpError cross-module identity', () => {
  test('foreign instance is not instanceof but IS recognized by the guards', () => {
    const foreign = new ForeignHttpError(401, 'Unauthorized', 'INVALID_SIGNATURE');
    expect(foreign instanceof HttpError).toBe(false); // the bug's precondition
    expect(isHttpError(foreign)).toBe(true); // the fix
    expect(isValidationError(new ForeignValidationError([]))).toBe(true);
    expect(isValidationError(foreign)).toBe(false);
  });

  test('a real HttpError is still recognized', () => {
    expect(isHttpError(new HttpError(404, 'nope'))).toBe(true);
    expect(isValidationError(new ValidationError([]))).toBe(true);
    expect(isHttpError(new Error('plain'))).toBe(false);
    expect(isHttpError(null)).toBe(false);
  });

  test('onError maps a cross-module HttpError to its status, not 500', async () => {
    const { app } = await createApp({
      meta: { name: 'cross-module-test', version: '0.0.0' },
      db: { mongo: false, redis: false },
      security: { signing: { secret: 'test-secret-key-must-be-at-least-32-chars!!' } },
      plugins: [
        {
          name: 'thrower',
          setupRoutes({ app }) {
            app.get('/boom', () => {
              throw new ForeignHttpError(401, 'Unauthorized', 'INVALID_SIGNATURE');
            });
            app.get('/invalid', () => {
              throw new ForeignValidationError([]);
            });
          },
        },
      ],
    } as Parameters<typeof createApp>[0]);

    const res = await app.request('/boom');
    expect(res.status).toBe(401); // was 500 before the fix
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.code).toBe('INVALID_SIGNATURE');

    const vres = await app.request('/invalid');
    expect(vres.status).toBe(400); // ValidationError branch, not 500
  });
});
