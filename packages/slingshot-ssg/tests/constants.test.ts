// packages/slingshot-ssg/tests/constants.test.ts
//
// Verify that the shared SSG constants are correct, referenced by the schema
// and CLI, and composed consistently so that no drift can occur between the
// Zod validation layer and the CLI arg parser clamp.
import { describe, expect, test } from 'bun:test';
import { MAX_CONCURRENCY } from '../src/constants';
import { ssgConfigSchema } from '../src/config.schema';
import { parseArgs } from '../src/cli';

const minimalValid = {
  serverRoutesDir: '/tmp/routes',
  assetsManifest: '/tmp/manifest.json',
  outDir: '/tmp/out',
};

describe('MAX_CONCURRENCY', () => {
  test('is a finite positive number', () => {
    expect(Number.isFinite(MAX_CONCURRENCY)).toBe(true);
    expect(MAX_CONCURRENCY).toBeGreaterThan(0);
  });

  test('equals 256', () => {
    expect(MAX_CONCURRENCY).toBe(256);
  });

  test('is an integer', () => {
    expect(Number.isInteger(MAX_CONCURRENCY)).toBe(true);
  });

  test('schema rejects concurrency above MAX_CONCURRENCY', () => {
    expect(
      ssgConfigSchema.safeParse({
        ...minimalValid,
        concurrency: MAX_CONCURRENCY + 1,
      }).success,
    ).toBe(false);
  });

  test('schema accepts concurrency exactly at MAX_CONCURRENCY', () => {
    expect(
      ssgConfigSchema.safeParse({
        ...minimalValid,
        concurrency: MAX_CONCURRENCY,
      }).success,
    ).toBe(true);
  });

  test('CLI parseArgs clamps values above MAX_CONCURRENCY', () => {
    const result = parseArgs(['--concurrency', '999999']);
    expect(result.concurrency).toBe(MAX_CONCURRENCY);
  });

  test('CLI parseArgs passes through values at MAX_CONCURRENCY', () => {
    const result = parseArgs(['--concurrency', String(MAX_CONCURRENCY)]);
    expect(result.concurrency).toBe(MAX_CONCURRENCY);
  });

});

