import { describe, expect, test } from 'bun:test';
import {
  createRouter,
  defaultHook,
  defaultValidationErrorFormatter,
  getSlingshotCtx,
} from '../../src/context';

describe('defaultValidationErrorFormatter', () => {
  test('formats issues into error + details', () => {
    const issues = [
      { path: ['user', 'email'], message: 'Required', code: 'invalid_type' as const },
      { path: ['age'], message: 'Must be positive', code: 'too_small' as const },
    ];
    const result = defaultValidationErrorFormatter(issues as never, 'req-123') as {
      error: string;
      details: { path: string; message: string }[];
      requestId: string;
    };
    expect(result.error).toBe('Required, Must be positive');
    expect(result.details).toEqual([
      { path: 'user.email', message: 'Required' },
      { path: 'age', message: 'Must be positive' },
    ]);
    expect(result.requestId).toBe('req-123');
  });

  test('handles empty issues', () => {
    const result = defaultValidationErrorFormatter([], 'req-0') as {
      error: string;
      details: unknown[];
    };
    expect(result.error).toBe('');
    expect(result.details).toEqual([]);
  });
});

describe('defaultHook', () => {
  test('passes through on success (returns undefined)', () => {
    const hookResultData = { success: true, data: {} };
    const hookResult: never = hookResultData as never;
    const hookCtxData = {};
    const hookCtx: never = hookCtxData as never;
    const result = defaultHook(hookResult, hookCtx);
    expect(result).toBeUndefined();
  });

  test('returns 400 JSON on validation failure', () => {
    let capturedStatus: number | undefined;
    let capturedBody: unknown;
    const c = {
      get: (key: string) => {
        if (key === 'requestId') return 'req-abc';
        if (key === 'validationErrorFormatter') return undefined;
        return undefined;
      },
      json: (body: unknown, status: number) => {
        capturedBody = body;
        capturedStatus = status;
        return { body, status };
      },
    };
    const issues = [{ path: ['name'], message: 'Required', code: 'invalid_type' }];
    const hookResultData = { success: false, error: { issues } };
    const hookResult: never = hookResultData as never;
    defaultHook(hookResult, c as never);
    expect(capturedStatus).toBe(400);
    expect((capturedBody as { requestId: string }).requestId).toBe('req-abc');
  });

  test('uses custom formatter when set', () => {
    const customFormatter = (issues: unknown[], reqId: string) => ({
      custom: true,
      count: (issues as unknown[]).length,
      reqId,
    });
    const c = {
      get: (key: string) => {
        if (key === 'requestId') return 'req-custom';
        if (key === 'validationErrorFormatter') return customFormatter;
        return undefined;
      },
      json: (body: unknown, status: number) => ({ body, status }),
    };
    const issues = [{ path: [], message: 'Bad', code: 'custom' }];
    const hookResultData = { success: false, error: { issues } };
    const hookResult: never = hookResultData as never;
    const result = defaultHook(hookResult, c as never) as {
      body: { custom: boolean };
      status: number;
    };
    expect(result.body.custom).toBe(true);
    expect(result.status).toBe(400);
  });

  test('falls back to default formatter when custom formatter throws', () => {
    const throwingFormatter = () => {
      throw new Error('formatter bug');
    };
    let capturedBody: unknown;
    const c = {
      get: (key: string) => {
        if (key === 'requestId') return 'req-fallback';
        if (key === 'validationErrorFormatter') return throwingFormatter;
        return undefined;
      },
      json: (body: unknown, status: number) => {
        capturedBody = body;
        return { body, status };
      },
    };
    const issues = [{ path: ['field'], message: 'Invalid', code: 'invalid_type' }];
    const hookResultData = { success: false, error: { issues } };
    const hookResult: never = hookResultData as never;
    defaultHook(hookResult, c as never);
    expect((capturedBody as { requestId: string }).requestId).toBe('req-fallback');
    expect((capturedBody as { details: unknown[] }).details).toHaveLength(1);
  });

  test('uses "unknown" when requestId is not a string', () => {
    let capturedBody: unknown;
    const c = {
      get: (key: string) => {
        if (key === 'requestId') return 42; // not a string
        return undefined;
      },
      json: (body: unknown, status: number) => {
        capturedBody = body;
        return { body, status };
      },
    };
    const issues = [{ path: [], message: 'Bad', code: 'custom' }];
    const hookResultData = { success: false, error: { issues } };
    const hookResult: never = hookResultData as never;
    defaultHook(hookResult, c as never);
    expect((capturedBody as { requestId: string }).requestId).toBe('unknown');
  });
});

describe('createRouter', () => {
  test('returns an OpenAPIHono instance with defaultHook', () => {
    const router = createRouter();
    expect(router).toBeDefined();
    expect(typeof router.get).toBe('function');
    expect(typeof router.post).toBe('function');
    expect(typeof router.openapi).toBe('function');
  });
});

describe('getSlingshotCtx', () => {
  test('returns slingshotCtx from context', () => {
    const fakeCtx = { name: 'test-ctx' };
    const c = {
      get: (key: string) => {
        if (key === 'slingshotCtx') return fakeCtx;
        return undefined;
      },
    };
    const result = getSlingshotCtx(c as never);
    expect(result).toBe(fakeCtx);
  });
});
