// packages/slingshot-ssg/tests/types-edge.test.ts
//
// Edge-case coverage for the SSG type definitions: SsgPageError contract,
// SsgPageResult discriminated union shape, SsgResult construction, and the
// behavior of errorDetail as a serializable mirror.
import { describe, expect, test } from 'bun:test';
import type { SsgPageError, SsgPageResult, SsgResult } from '../src/types';

describe('SsgPageError shape', () => {
  test('constructs with message, name, and route', () => {
    const err: SsgPageError = {
      message: 'render failed',
      name: 'Error',
      route: '/about',
    };
    expect(err.message).toBe('render failed');
    expect(err.name).toBe('Error');
    expect(err.route).toBe('/about');
  });

  test('stack is optional', () => {
    const withStack: SsgPageError = {
      message: 'boom',
      name: 'TypeError',
      stack: 'TypeError: boom\n    at render (file.ts:1:1)',
      route: '/crash',
    };
    expect(withStack.stack).toBeDefined();

    const withoutStack: SsgPageError = {
      message: 'boom',
      name: 'TypeError',
      route: '/crash',
    };
    expect(withoutStack.stack).toBeUndefined();
  });

  test('route matches the page path that failed', () => {
    const err: SsgPageError = {
      message: 'timeout',
      name: 'TimeoutError',
      route: '/deeply/nested/page',
    };
    expect(err.route).toBe('/deeply/nested/page');
  });
});

describe('SsgPageResult discriminated shape', () => {
  test('success result has no error and no errorDetail', () => {
    const result: SsgPageResult = {
      path: '/ok',
      filePath: '/tmp/out/ok/index.html',
      durationMs: 42,
    };
    expect(result.error).toBeUndefined();
    expect(result.errorDetail).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('failure result has error and errorDetail', () => {
    const error = new Error('render failure');
    const result: SsgPageResult = {
      path: '/fail',
      filePath: '/tmp/out/fail/index.html',
      durationMs: 100,
      error,
      errorDetail: {
        message: 'render failure',
        name: 'Error',
        route: '/fail',
      },
    };
    expect(result.error).toBeInstanceOf(Error);
    expect(result.errorDetail).toBeDefined();
    expect(result.errorDetail?.message).toBe(error.message);
    expect(result.errorDetail?.route).toBe(result.path);
  });

  test('errorDetail mirrors error name even for subclasses', () => {
    const error = new TypeError('type mismatch');
    const result: SsgPageResult = {
      path: '/type-error',
      filePath: '/tmp/out/type-error/index.html',
      durationMs: 5,
      error,
      errorDetail: {
        message: error.message,
        name: error.name,
        stack: error.stack!,
        route: '/type-error',
      },
    };
    expect(result.errorDetail?.name).toBe('TypeError');
  });

  test('durationMs is always non-negative on success', () => {
    const result: SsgPageResult = {
      path: '/fast',
      filePath: '/tmp/out/fast/index.html',
      durationMs: 0,
    };
    expect(result.durationMs).toBe(0);
  });

  test('durationMs is non-negative on failure', () => {
    const result: SsgPageResult = {
      path: '/slow-fail',
      filePath: '/tmp/out/slow-fail/index.html',
      durationMs: 1500,
      error: new Error('too slow'),
      errorDetail: {
        message: 'too slow',
        name: 'Error',
        route: '/slow-fail',
      },
    };
    expect(result.durationMs).toBe(1500);
  });
});

describe('SsgResult aggregate', () => {
  test('empty result has zero counts and empty pages', () => {
    const result: SsgResult = {
      pages: [],
      durationMs: 0,
      succeeded: 0,
      failed: 0,
    };
    expect(result.pages).toHaveLength(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  test('all-success result has correct counts', () => {
    const result: SsgResult = {
      pages: [
        { path: '/a', filePath: '/out/a/index.html', durationMs: 10 },
        { path: '/b', filePath: '/out/b/index.html', durationMs: 20 },
      ],
      durationMs: 30,
      succeeded: 2,
      failed: 0,
    };
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
  });

  test('partial failure aggregates counts correctly', () => {
    const result: SsgResult = {
      pages: [
        { path: '/a', filePath: '/out/a/index.html', durationMs: 10 },
        {
          path: '/b',
          filePath: '/out/b/index.html',
          durationMs: 50,
          error: new Error('fail'),
          errorDetail: { message: 'fail', name: 'Error', route: '/b' },
        },
        { path: '/c', filePath: '/out/c/index.html', durationMs: 15 },
      ],
      durationMs: 75,
      succeeded: 2,
      failed: 1,
    };
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.pages.filter(p => p.error).length).toBe(1);
    expect(result.pages.filter(p => !p.error).length).toBe(2);
  });

  test('total failure still records pages with error details', () => {
    const result: SsgResult = {
      pages: [
        {
          path: '/x',
          filePath: '/out/x/index.html',
          durationMs: 5,
          error: new Error('err1'),
          errorDetail: { message: 'err1', name: 'Error', route: '/x' },
        },
        {
          path: '/y',
          filePath: '/out/y/index.html',
          durationMs: 10,
          error: new Error('err2'),
          errorDetail: { message: 'err2', name: 'Error', route: '/y' },
        },
      ],
      durationMs: 15,
      succeeded: 0,
      failed: 2,
    };
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
  });
});
