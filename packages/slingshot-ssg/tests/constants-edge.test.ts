import { describe, expect, test } from 'bun:test';
import { SsgExitCode, resolveExitCode } from '../src/cli';
import { SsgError, SsgConfigError, SsgCrawlError, SsgRenderError, SsgCliArgError } from '../src/errors';

describe('SsgExitCode', () => {
  test('exit code 0 on success', () => {
    const result = resolveExitCode({ errors: [], pages: 10 });
    expect(result).toBe(SsgExitCode.Success);
  });

  test('exit code 1 on partial failure', () => {
    const result = resolveExitCode({ errors: [new Error('one fail')], pages: 10 });
    expect(result).toBe(SsgExitCode.PartialFailure);
  });

  test('exit code 2 on total failure', () => {
    const result = resolveExitCode({ errors: [new Error('fail')], pages: 0 });
    expect(result).toBe(SsgExitCode.TotalFailure);
  });

  test('exit code 0 with empty pages but no errors', () => {
    const result = resolveExitCode({ errors: [], pages: 0 });
    expect(result).toBe(SsgExitCode.Success);
  });
});

describe('SsgError classes', () => {
  test('SsgError extends Error', () => {
    const err = new SsgError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SsgError');
    expect(err.message).toContain('[slingshot-ssg]');
  });

  test('SsgConfigError extends SsgError', () => {
    const err = new SsgConfigError('invalid config');
    expect(err).toBeInstanceOf(SsgError);
    expect(err.name).toBe('SsgConfigError');
  });

  test('SsgCrawlError extends SsgError', () => {
    const err = new SsgCrawlError('crawl failure');
    expect(err).toBeInstanceOf(SsgError);
    expect(err.name).toBe('SsgCrawlError');
  });

  test('SsgRenderError carries URL', () => {
    const err = new SsgRenderError('/test-page', new Error('render failed'));
    expect(err).toBeInstanceOf(SsgError);
    expect(err.name).toBe('SsgRenderError');
    expect(err.url).toBe('/test-page');
    expect(err.message).toContain('/test-page');
  });

  test('SsgRenderError without cause', () => {
    const err = new SsgRenderError('/page');
    expect(err.url).toBe('/page');
    expect(err.message).toContain('/page');
  });

  test('SsgCliArgError for invalid integer arg', () => {
    const err = new SsgCliArgError('concurrency', 'abc');
    expect(err).toBeInstanceOf(SsgError);
    expect(err.name).toBe('SsgCliArgError');
    expect(err.message).toContain('concurrency');
    expect(err.message).toContain('abc');
  });
});
