import { describe, expect, test } from 'bun:test';
import type { ZodIssue } from 'zod';
import { defaultValidationErrorFormatter } from '@lastshotlabs/slingshot-core';

function makeIssue(path: (string | number)[], message: string): ZodIssue {
  const issue = { code: 'custom', path, message };
  return issue as ZodIssue;
}

describe('defaultValidationErrorFormatter', () => {
  test('flat path', () => {
    const result = defaultValidationErrorFormatter([makeIssue(['email'], 'Required')], 'req-1');
    expect(result).toEqual({
      error: 'Required',
      details: [{ path: 'email', message: 'Required' }],
      requestId: 'req-1',
    });
  });

  test('nested path (dot-joined)', () => {
    const result = defaultValidationErrorFormatter(
      [makeIssue(['user', 'email'], 'Invalid email')],
      'req-2',
    );
    expect(result).toEqual({
      error: 'Invalid email',
      details: [{ path: 'user.email', message: 'Invalid email' }],
      requestId: 'req-2',
    });
  });

  test('array index path', () => {
    const result = defaultValidationErrorFormatter(
      [makeIssue(['items', 0, 'name'], 'Required')],
      'req-3',
    );
    expect(result).toEqual({
      error: 'Required',
      details: [{ path: 'items.0.name', message: 'Required' }],
      requestId: 'req-3',
    });
  });

  test('empty path (root-level error)', () => {
    const result = defaultValidationErrorFormatter([makeIssue([], 'Invalid input')], 'req-4');
    expect(result).toEqual({
      error: 'Invalid input',
      details: [{ path: '', message: 'Invalid input' }],
      requestId: 'req-4',
    });
  });

  test('multiple issues — error is comma-joined, details has one entry per issue', () => {
    const result = defaultValidationErrorFormatter(
      [makeIssue(['name'], 'Required'), makeIssue(['age'], 'Expected number, received string')],
      'req-5',
    ) as { error: string; details: { path: string; message: string }[]; requestId: string };
    expect(result.error).toBe('Required, Expected number, received string');
    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toEqual({ path: 'name', message: 'Required' });
    expect(result.details[1]).toEqual({ path: 'age', message: 'Expected number, received string' });
    expect(result.requestId).toBe('req-5');
  });

  test('requestId is included in output', () => {
    const result = defaultValidationErrorFormatter([makeIssue(['x'], 'Bad')], 'my-request-id') as {
      requestId: string;
    };
    expect(result.requestId).toBe('my-request-id');
  });
});
