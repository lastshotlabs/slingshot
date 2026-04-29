import { describe, expect, test } from 'bun:test';
import {
  SsgExitCode,
  TEST_SSG_RENDER_TIMEOUT_MS,
  createTestSsgConfig,
  resolveExitCode,
} from '../src/testing';

describe('ssg testing entrypoint', () => {
  test('exports render defaults, config factory, and exit code helpers', () => {
    expect(TEST_SSG_RENDER_TIMEOUT_MS).toBe(30_000);
    expect(createTestSsgConfig({ outDir: '/tmp/static', baseUrl: 'https://example.test' })).toEqual(
      {
        outDir: '/tmp/static',
        baseUrl: 'https://example.test',
        routes: ['/'],
      },
    );
    expect(resolveExitCode(1, 1)).toBe(SsgExitCode.PartialFailure);
  });
});
