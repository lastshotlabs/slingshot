/**
 * Tests for SSG CLI argument-parsing edge cases.
 *
 * Exercises `parseArgs` directly with pathological inputs, boundary values,
 * and combinations not covered by the main CLI test suite.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { parseArgs, runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slingshot-ssg-edge-'));
  tempDirs.push(dir);
  return dir;
}

function writeFixtureFile(baseDir: string, relativePath: string, contents: string): string {
  const filePath = join(baseDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers — build argv arrays for parseArgs tests
// ---------------------------------------------------------------------------

const DEFAULTS = {
  routesDir: 'server/routes',
  assetsManifest: 'dist/client/.vite/manifest.json',
  outDir: 'dist/static',
  concurrency: 4,
  rendererPath: 'dist/server/entry-server.js',
  clientEntry: undefined,
  rscManifestPath: undefined,
  watch: false,
  help: false,
  retryMaxAttempts: 3,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30000,
  breakerThreshold: undefined,
  breakerCooldownMs: undefined,
} as const;

// ---------------------------------------------------------------------------
// 1. Missing / absent flags
// ---------------------------------------------------------------------------

describe('missing flags', () => {
  test('parseArgs with empty argv returns all defaults', () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
  });

  test('flag without following value is treated as boolean marker', () => {
    // --retry is a value flag; when it is the last arg with no following
    // value, parseArgs records the key with 'true' as the value and
    // parsePositiveIntArg('true', ...) throws because 'true' is not a
    // finite integer.
    expect(() => parseArgs(['--retry'])).toThrow(/--retry.*positive integer/);
  });

  test('client-entry and rsc-manifest are undefined when omitted', () => {
    const opts = parseArgs([
      '--routes-dir',
      'routes',
      '--renderer',
      'renderer.js',
    ]);
    expect(opts.clientEntry).toBeUndefined();
    expect(opts.rscManifestPath).toBeUndefined();
  });

  test('breaker-threshold and breaker-cooldown are undefined when omitted', () => {
    const opts = parseArgs(['--routes-dir', 'routes']);
    expect(opts.breakerThreshold).toBeUndefined();
    expect(opts.breakerCooldownMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid concurrency values
// ---------------------------------------------------------------------------

describe('invalid concurrency values', () => {
  const BAD_VALUES: Array<[string, string]> = [
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['non-numeric string', 'banana'],
  ];

  for (const [label, raw] of BAD_VALUES) {
    test(`throws for ${label}: "${raw}"`, () => {
      expect(() => parseArgs(['--concurrency', raw])).toThrow(
        /--concurrency.*positive integer/,
      );
    });
  }

  test('negative concurrency is clamped to 1', () => {
    expect(parseArgs(['--concurrency', '-1']).concurrency).toBe(1);
    expect(parseArgs(['--concurrency', '-999']).concurrency).toBe(1);
  });

  test('zero concurrency is clamped to 1', () => {
    expect(parseArgs(['--concurrency', '0']).concurrency).toBe(1);
  });

  test('hexadecimal is silently parsed as integer then clamped', () => {
    // Number('0xFF') = 255 — JS Number() accepts 0x notation
    expect(parseArgs(['--concurrency', '0xFF']).concurrency).toBe(255);
  });

  test('scientific notation is silently parsed as integer then clamped', () => {
    // Number('1e3') = 1000 — JS Number() accepts scientific notation
    expect(parseArgs(['--concurrency', '1e3']).concurrency).toBe(256);
  });

  test('empty string value is treated as missing flag value and throws', () => {
    // Empty string '' is falsy in JS, so the parser treats it as a
    // missing value and sets args['concurrency'] = 'true', which then
    // fails parsePositiveIntArg.
    expect(() => parseArgs(['--concurrency', ''])).toThrow(
      /--concurrency.*positive integer/,
    );
  });

  test('fractional concurrency throws', () => {
    expect(() => parseArgs(['--concurrency', '1.5'])).toThrow(
      /--concurrency.*positive integer/,
    );
    expect(() => parseArgs(['--concurrency', '3.14'])).toThrow(
      /--concurrency.*positive integer/,
    );
  });

  test('very large concurrency is clamped to MAX_CONCURRENCY (256)', () => {
    expect(parseArgs(['--concurrency', '257']).concurrency).toBe(256);
    expect(parseArgs(['--concurrency', '1000']).concurrency).toBe(256);
    expect(parseArgs(['--concurrency', '999999']).concurrency).toBe(256);
  });

  test('concurrency at exact boundary values', () => {
    // Min
    expect(parseArgs(['--concurrency', '1']).concurrency).toBe(1);
    // Default
    expect(parseArgs(['--concurrency', '4']).concurrency).toBe(4);
    // Max
    expect(parseArgs(['--concurrency', '256']).concurrency).toBe(256);
  });

  test('concurrency flag repeated — last value wins', () => {
    expect(
      parseArgs([
        '--concurrency',
        '2',
        '--concurrency',
        '8',
      ]).concurrency,
    ).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid retry values
// ---------------------------------------------------------------------------

describe('invalid retry values', () => {
  const BAD_VALUES: Array<[string, string]> = [
    ['NaN', 'NaN'],
    ['non-numeric', 'xyz'],
    ['float', '2.5'],
  ];

  for (const [label, raw] of BAD_VALUES) {
    test(`throws for ${label}: "${raw}"`, () => {
      expect(() => parseArgs(['--retry', raw])).toThrow(
        /--retry.*positive integer/,
      );
    });
  }

  test('hex retry is parsed as integer, 0xA=10, clamped to 10', () => {
    expect(parseArgs(['--retry', '0xA']).retryMaxAttempts).toBe(10);
  });

  test('empty string retry is treated as missing value and throws', () => {
    expect(() => parseArgs(['--retry', ''])).toThrow(
      /--retry.*positive integer/,
    );
  });

  test('negative retry is clamped to 1', () => {
    expect(parseArgs(['--retry', '-5']).retryMaxAttempts).toBe(1);
  });

  test('zero retry is clamped to 1', () => {
    expect(parseArgs(['--retry', '0']).retryMaxAttempts).toBe(1);
  });

  test('retry above max (10) is clamped to 10', () => {
    expect(parseArgs(['--retry', '11']).retryMaxAttempts).toBe(10);
    expect(parseArgs(['--retry', '100']).retryMaxAttempts).toBe(10);
  });

  test('retry at exact boundary values', () => {
    // Min
    expect(parseArgs(['--retry', '1']).retryMaxAttempts).toBe(1);
    // Default
    expect(parseArgs(['--retry', '3']).retryMaxAttempts).toBe(3);
    // Max
    expect(parseArgs(['--retry', '10']).retryMaxAttempts).toBe(10);
  });

  test('retry-base-delay clamps below 100 to 100', () => {
    expect(parseArgs(['--retry-base-delay', '0']).retryBaseDelayMs).toBe(100);
    expect(parseArgs(['--retry-base-delay', '99']).retryBaseDelayMs).toBe(100);
    // Valid mid-range
    expect(parseArgs(['--retry-base-delay', '500']).retryBaseDelayMs).toBe(500);
    // Above 60_000 clamps
    expect(parseArgs(['--retry-base-delay', '70000']).retryBaseDelayMs).toBe(60000);
  });

  test('retry-base-delay throws for non-numeric', () => {
    expect(() => parseArgs(['--retry-base-delay', 'abc'])).toThrow(
      /--retry-base-delay.*positive integer/,
    );
  });

  test('retry-max-delay clamps below 100 to 100', () => {
    expect(parseArgs(['--retry-max-delay', '50']).retryMaxDelayMs).toBe(100);
    // Above 120_000 clamps
    expect(parseArgs(['--retry-max-delay', '200000']).retryMaxDelayMs).toBe(120000);
  });

  test('retry-max-delay throws for non-numeric', () => {
    expect(() => parseArgs(['--retry-max-delay', 'Infinity'])).toThrow(
      /--retry-max-delay.*positive integer/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid breaker threshold values
// ---------------------------------------------------------------------------

describe('invalid breaker threshold values', () => {
  const BAD_VALUES: Array<[string, string]> = [
    ['NaN', 'NaN'],
    ['non-numeric', 'abc'],
  ];

  for (const [label, raw] of BAD_VALUES) {
    test(`throws for ${label}: "${raw}"`, () => {
      expect(() => parseArgs(['--breaker-threshold', raw])).toThrow(
        /--breaker-threshold.*positive integer/,
      );
    });
  }

  test('breaker-threshold: scientific notation 1e2=100, at max', () => {
    expect(parseArgs(['--breaker-threshold', '1e2']).breakerThreshold).toBe(100);
  });

  test('breaker-threshold: empty string treated as missing value and throws', () => {
    expect(() => parseArgs(['--breaker-threshold', ''])).toThrow(
      /--breaker-threshold.*positive integer/,
    );
  });

  test('breaker-threshold: negative clamped to 1', () => {
    expect(parseArgs(['--breaker-threshold', '-1']).breakerThreshold).toBe(1);
    expect(parseArgs(['--breaker-threshold', '-100']).breakerThreshold).toBe(1);
  });

  test('breaker-threshold: zero clamped to 1', () => {
    expect(parseArgs(['--breaker-threshold', '0']).breakerThreshold).toBe(1);
  });

  test('breaker-threshold: above max (100) clamped to 100', () => {
    expect(parseArgs(['--breaker-threshold', '101']).breakerThreshold).toBe(100);
    expect(parseArgs(['--breaker-threshold', '5000']).breakerThreshold).toBe(100);
  });

  test('breaker-threshold: fractional throws', () => {
    expect(() => parseArgs(['--breaker-threshold', '3.7'])).toThrow(
      /--breaker-threshold.*positive integer/,
    );
  });

  test('breaker-threshold: exact boundary values', () => {
    // Min
    expect(parseArgs(['--breaker-threshold', '1']).breakerThreshold).toBe(1);
    // Mid (default is 5 when not omitted, but undefined when omitted)
    expect(parseArgs(['--breaker-threshold', '5']).breakerThreshold).toBe(5);
    // Max
    expect(parseArgs(['--breaker-threshold', '100']).breakerThreshold).toBe(100);
  });

  test('breaker-cooldown clamps below 1000 to 1000', () => {
    expect(parseArgs(['--breaker-cooldown', '0']).breakerCooldownMs).toBe(1000);
    expect(parseArgs(['--breaker-cooldown', '999']).breakerCooldownMs).toBe(1000);
  });

  test('breaker-cooldown clamps above 300_000 to 300_000', () => {
    expect(parseArgs(['--breaker-cooldown', '300001']).breakerCooldownMs).toBe(300000);
    expect(parseArgs(['--breaker-cooldown', '999999']).breakerCooldownMs).toBe(300000);
  });

  test('breaker-cooldown throws for non-numeric', () => {
    expect(() => parseArgs(['--breaker-cooldown', 'NaN'])).toThrow(
      /--breaker-cooldown.*positive integer/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Path validation — non-existent routes directory
// ---------------------------------------------------------------------------

describe('path validation', () => {
  test('runCli with non-existent routes dir returns early', async () => {
    const tempDir = makeTempDir();
    const missingDir = join(tempDir, 'does-not-exist');
    const rendererPath = writeFixtureFile(
      tempDir,
      'renderer.ts',
      `export default { async resolve() { return null; }, async render() { return new Response(''); } };\n`,
    );

    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    // The crawler returns empty for non-existent dir, so runCli logs
    // "No SSG routes found" and returns.
    await expect(
      runCli(['--routes-dir', missingDir, '--renderer', rendererPath]),
    ).resolves.toBeUndefined();

    const foundNoRoutes = logSpy.mock.calls.some(([msg]) =>
      String(msg).includes('No SSG routes found'),
    );
    expect(foundNoRoutes).toBe(true);

    logSpy.mockRestore();
  });

  test('runCli with empty routes dir returns early with no-routes message', async () => {
    const tempDir = makeTempDir();
    const emptyDir = join(tempDir, 'empty-routes');
    mkdirSync(emptyDir, { recursive: true });

    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runCli(['--routes-dir', emptyDir, '--renderer', join(tempDir, 'missing-renderer.ts')]),
    ).resolves.toBeUndefined();

    const foundNoRoutes = logSpy.mock.calls.some(([msg]) =>
      String(msg).includes('No SSG routes found'),
    );
    expect(foundNoRoutes).toBe(true);

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6. Help flag
// ---------------------------------------------------------------------------

describe('help flag', () => {
  test('--help sets help=true and allows callers to detect it', () => {
    const opts = parseArgs(['--help']);
    expect(opts.help).toBe(true);
  });

  test('--help with other flags still sets help=true', () => {
    const opts = parseArgs([
      '--help',
      '--routes-dir',
      'custom/routes',
      '--concurrency',
      '8',
    ]);
    expect(opts.help).toBe(true);
    // Other flags should still be parsed
    expect(opts.routesDir).toBe('custom/routes');
    expect(opts.concurrency).toBe(8);
  });

  test('--help consumes a following non-flag token as its value', () => {
    // The parser eats the next token when it does not start with '--'.
    // So '--help' takes '8' as its value: args['help'] = '8', not 'true'.
    // help resolves to '8' === 'true' = false.
    const opts = parseArgs(['--help', '8']);
    expect(opts.help).toBe(false);
    // '8' is consumed as the help value, not interpreted as concurrency
    expect(opts.concurrency).toBe(4); // default unchanged
  });

  test('--help output is produced by runCli', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    await runCli(['--help']);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Usage:');
    expect(output).toContain('--routes-dir');
    expect(output).toContain('--concurrency');
    expect(output).toContain('--retry');
    expect(output).toContain('--breaker-threshold');
    expect(output).toContain('--watch');
    expect(output).toContain('--help');

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 7. Boundary values for all numeric flags
// ---------------------------------------------------------------------------

describe('boundary values', () => {
  test('retry at max (10) still allows all flags to be set', () => {
    const opts = parseArgs([
      '--retry', '10',
      '--retry-base-delay', '60000',
      '--retry-max-delay', '120000',
    ]);
    expect(opts.retryMaxAttempts).toBe(10);
    expect(opts.retryBaseDelayMs).toBe(60000);
    expect(opts.retryMaxDelayMs).toBe(120000);
  });

  test('concurrency at max (256) with all other defaults', () => {
    const opts = parseArgs(['--concurrency', '256', '--routes-dir', 'routes']);
    expect(opts.concurrency).toBe(256);
    expect(opts.routesDir).toBe('routes');
    // Everything else remains default
    expect(opts.retryMaxAttempts).toBe(3);
    expect(opts.breakerThreshold).toBeUndefined();
  });

  test('breaker-threshold=1 and breaker-cooldown=1000 at min', () => {
    const opts = parseArgs([
      '--breaker-threshold', '1',
      '--breaker-cooldown', '1000',
    ]);
    expect(opts.breakerThreshold).toBe(1);
    expect(opts.breakerCooldownMs).toBe(1000);
  });

  test('breaker-threshold=100 and breaker-cooldown=300000 at max', () => {
    const opts = parseArgs([
      '--breaker-threshold', '100',
      '--breaker-cooldown', '300000',
    ]);
    expect(opts.breakerThreshold).toBe(100);
    expect(opts.breakerCooldownMs).toBe(300000);
  });

  test('retry-base-delay at min (100) and max (60000)', () => {
    expect(parseArgs(['--retry-base-delay', '100']).retryBaseDelayMs).toBe(100);
    expect(parseArgs(['--retry-base-delay', '60000']).retryBaseDelayMs).toBe(60000);
  });

  test('retry-max-delay at min (100) and max (120000)', () => {
    expect(parseArgs(['--retry-max-delay', '100']).retryMaxDelayMs).toBe(100);
    expect(parseArgs(['--retry-max-delay', '120000']).retryMaxDelayMs).toBe(120000);
  });

  test('all numeric flags set to mid-range values simultaneously', () => {
    const opts = parseArgs([
      '--concurrency', '16',
      '--retry', '5',
      '--retry-base-delay', '2000',
      '--retry-max-delay', '30000',
      '--breaker-threshold', '10',
      '--breaker-cooldown', '15000',
    ]);
    expect(opts.concurrency).toBe(16);
    expect(opts.retryMaxAttempts).toBe(5);
    expect(opts.retryBaseDelayMs).toBe(2000);
    expect(opts.retryMaxDelayMs).toBe(30000);
    expect(opts.breakerThreshold).toBe(10);
    expect(opts.breakerCooldownMs).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// 8. Watch flag parsing
// ---------------------------------------------------------------------------

describe('watch flag parsing', () => {
  test('--watch alone sets watch=true', () => {
    expect(parseArgs(['--watch']).watch).toBe(true);
  });

  test('--watch true sets watch=true', () => {
    expect(parseArgs(['--watch', 'true']).watch).toBe(true);
  });

  test('--watch false sets watch=false', () => {
    expect(parseArgs(['--watch', 'false']).watch).toBe(false);
  });

  test('--watch followed by a flag sets watch=true and does not eat the next flag', () => {
    const opts = parseArgs(['--watch', '--concurrency', '16']);
    expect(opts.watch).toBe(true);
    expect(opts.concurrency).toBe(16);
  });

  test('--watch with no following value after all positional args works', () => {
    const opts = parseArgs(['--routes-dir', 'routes', '--watch']);
    expect(opts.watch).toBe(true);
    expect(opts.routesDir).toBe('routes');
  });

  test('--watch=false is not parsed as watch flag', () => {
    // The parser splits on '--' and takes the rest as the key.
    // '--watch=false' becomes key='watch=false' which is stored in args
    // but does NOT set args['watch'].
    const opts = parseArgs(['--watch=false']);
    // watch stays at default since args['watch'] was never set
    expect(opts.watch).toBe(false);
  });

  test('watch defaults to false when not provided', () => {
    expect(parseArgs([]).watch).toBe(false);
    expect(parseArgs(['--concurrency', '8']).watch).toBe(false);
  });

  test('watch=true in runCli does not call process.exit', async () => {
    const tempDir = makeTempDir();
    const routesDir = join(tempDir, 'routes');
    mkdirSync(routesDir, { recursive: true });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    // With an empty routes dir and watch=true, the runCli should return
    // early (no routes found) and NOT enter watch mode (since no routes
    // means no watcher is set up).
    await expect(
      runCli([
        '--routes-dir',
        routesDir,
        '--watch',
        '--renderer',
        join(tempDir, 'missing.ts'),
      ]),
    ).resolves.toBeUndefined();

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 9. Mixed edge combinations
// ---------------------------------------------------------------------------

describe('mixed edge combinations', () => {
  test('all flags with pathological values are clamped not thrown', () => {
    const opts = parseArgs([
      '--concurrency', '-100',
      '--retry', '0',
      '--retry-base-delay', '-50',
      '--retry-max-delay', '0',
      '--breaker-threshold', '-1',
      '--breaker-cooldown', '0',
    ]);
    expect(opts.concurrency).toBe(1);
    expect(opts.retryMaxAttempts).toBe(1);
    expect(opts.retryBaseDelayMs).toBe(100);
    expect(opts.retryMaxDelayMs).toBe(100);
    expect(opts.breakerThreshold).toBe(1);
    expect(opts.breakerCooldownMs).toBe(1000);
  });

  test('parseArgs validates eagerly — invalid values throw even with --help', () => {
    // parsePositiveIntArg is called for every value flag regardless of
    // whether --help is present. The caller (runCli) checks help first
    // after parseArgs returns, but parseArgs itself still validates.
    expect(() => parseArgs(['--help', '--concurrency', 'banana'])).toThrow(
      /--concurrency.*positive integer/,
    );
  });
});
