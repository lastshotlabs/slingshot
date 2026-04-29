import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  loadRenderer,
  parseArgs,
  resolveAssetTagsHtml,
  runCli,
  warnIfConcurrencyExceedsFdHeadroom,
} from '../src/cli';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slingshot-ssg-cli-unit-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFixtureFile(
  baseDir: string,
  relativePath: string,
  contents: string,
): Promise<string> {
  const filePath = join(baseDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

afterEach(async () => {
  mock.restore();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('slingshot-ssg cli internals', () => {
  test('parseArgs applies defaults and reads explicit flags', () => {
    expect(parseArgs([])).toEqual({
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
    });

    expect(
      parseArgs([
        '--routes-dir',
        'app/routes',
        '--assets-manifest',
        'dist/manifest.json',
        '--out',
        'build/static',
        '--concurrency',
        '8',
        '--renderer',
        'dist/server/custom.js',
        '--client-entry',
        'src/client/index.ts',
        '--rsc-manifest',
        'dist/rsc-manifest.json',
      ]),
    ).toEqual({
      routesDir: 'app/routes',
      assetsManifest: 'dist/manifest.json',
      outDir: 'build/static',
      concurrency: 8,
      rendererPath: 'dist/server/custom.js',
      clientEntry: 'src/client/index.ts',
      rscManifestPath: 'dist/rsc-manifest.json',
      watch: false,
      help: false,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
      breakerThreshold: undefined,
      breakerCooldownMs: undefined,
    });
  });

  test('parseArgs treats a valueless flag as boolean text for legacy compatibility', () => {
    expect(parseArgs(['--renderer']).rendererPath).toBe('true');
  });

  test('parseArgs rejects malformed concurrency values and clamps very large values', () => {
    expect(() => parseArgs(['--concurrency', '2abc'])).toThrow(
      '--concurrency must be a positive integer',
    );
    expect(() => parseArgs(['--concurrency', '1.5'])).toThrow(
      '--concurrency must be a positive integer',
    );
    expect(parseArgs(['--concurrency', '999999']).concurrency).toBe(256);
    expect(parseArgs(['--concurrency', '0']).concurrency).toBe(1);
  });

  test('resolveAssetTagsHtml auto-detects the client entry and warns when the manifest is missing', async () => {
    const tempDir = await makeTempDir();
    const manifestPath = join(tempDir, 'manifest.json');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    expect(await resolveAssetTagsHtml(join(tempDir, 'missing.json'), undefined)).toBe('');
    expect(warn).toHaveBeenCalled();

    await writeFile(
      manifestPath,
      JSON.stringify({
        'src/client/main.ts': {
          file: 'assets/app.js',
          css: ['assets/app.css'],
          isEntry: true,
        },
      }),
      'utf8',
    );

    const tags = await resolveAssetTagsHtml(manifestPath, undefined);
    expect(tags).toContain('<link rel="stylesheet" href="/assets/app.css">');
    expect(tags).toContain('<script type="module" src="/assets/app.js"></script>');
  });

  test('resolveAssetTagsHtml returns empty tags for invalid or unresolvable manifests', async () => {
    const tempDir = await makeTempDir();
    const manifestPath = join(tempDir, 'manifest.json');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    await writeFile(manifestPath, '[]', 'utf8');
    expect(await resolveAssetTagsHtml(manifestPath, undefined)).toBe('');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('not a JSON object');

    await writeFile(
      manifestPath,
      JSON.stringify({ 'src/other.ts': { file: 'assets/other.js' } }),
      'utf8',
    );
    expect(await resolveAssetTagsHtml(manifestPath, undefined)).toBe('');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('Could not find a client entry chunk');

    expect(await resolveAssetTagsHtml(manifestPath, 'src/client/missing.ts')).toBe('');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('Client entry key');

    await writeFile(manifestPath, '{', 'utf8');
    expect(await resolveAssetTagsHtml(manifestPath, undefined)).toBe('');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('Failed to parse asset manifest');
  });

  test('parseArgs clamps negative --concurrency to 1 and accepts mid-range values', () => {
    // Negative is clamped to the lower bound (1)
    expect(parseArgs(['--concurrency', '-5']).concurrency).toBe(1);

    // Valid mid-range values pass through unchanged
    expect(parseArgs(['--concurrency', '8']).concurrency).toBe(8);
    expect(parseArgs(['--concurrency', '256']).concurrency).toBe(256);

    // Non-numeric strings throw with an explicit message naming the flag
    expect(() => parseArgs(['--concurrency', 'banana'])).toThrow(/--concurrency/);
    expect(() => parseArgs(['--concurrency', 'banana'])).toThrow(/positive integer/);
  });

  test('warnIfConcurrencyExceedsFdHeadroom warns when concurrency exceeds the FD heuristic', () => {
    const proc = process as unknown as {
      getrlimit?: () => { nofile: number };
    };
    const original = proc.getrlimit;
    proc.getrlimit = () => ({ nofile: 1024 });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // (1024 - 256) / 4 = 192. concurrency 200 should trip the warning.
      warnIfConcurrencyExceedsFdHeadroom(200);
      expect(warn).toHaveBeenCalled();
      const [first] = warn.mock.calls[0] ?? [];
      expect(String(first)).toContain('FD ulimit');

      warn.mockClear();
      // 100 < 192 — no warning expected.
      warnIfConcurrencyExceedsFdHeadroom(100);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      proc.getrlimit = original;
    }
  });

  test('warnIfConcurrencyExceedsFdHeadroom no-ops when getrlimit is unavailable', () => {
    const proc = process as unknown as { getrlimit?: () => { nofile: number } };
    const original = proc.getrlimit;
    delete proc.getrlimit;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      warnIfConcurrencyExceedsFdHeadroom(10_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) proc.getrlimit = original;
    }
  });

  test('warnIfConcurrencyExceedsFdHeadroom no-ops when nofile is absent or invalid', () => {
    const proc = process as unknown as { getrlimit?: () => { nofile?: number } | undefined };
    const original = proc.getrlimit;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      proc.getrlimit = () => undefined;
      warnIfConcurrencyExceedsFdHeadroom(10_000);
      proc.getrlimit = () => ({});
      warnIfConcurrencyExceedsFdHeadroom(10_000);
      proc.getrlimit = () => ({ nofile: 0 });
      warnIfConcurrencyExceedsFdHeadroom(10_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      proc.getrlimit = original;
    }
  });

  test('loadRenderer rejects missing and invalid renderer modules', async () => {
    const tempDir = await makeTempDir();
    const invalidRendererPath = join(tempDir, 'renderer.ts');

    await writeFile(invalidRendererPath, 'export default { resolve: true }\n', 'utf8');

    await expect(loadRenderer(join(tempDir, 'missing-renderer.js'))).rejects.toThrow(
      'Renderer module not found',
    );
    await expect(loadRenderer(invalidRendererPath)).rejects.toThrow(
      'does not export a valid SlingshotSsrRenderer',
    );
  });

  test('loadRenderer accepts named renderer exports', async () => {
    const tempDir = await makeTempDir();
    const rendererPath = await writeFixtureFile(
      tempDir,
      'named-renderer.ts',
      `
export const renderer = {
  async resolve() {
    return null;
  },
  async render() {
    return new Response('<html></html>');
  },
};
`,
    );

    const renderer = await loadRenderer(rendererPath);
    expect(typeof renderer.resolve).toBe('function');
    expect(typeof renderer.render).toBe('function');
  });

  test('runCli returns early when no SSG routes are discovered', async () => {
    const tempDir = await makeTempDir();
    const routesDir = join(tempDir, 'routes');
    await mkdir(routesDir, { recursive: true });
    const log = spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runCli(['--routes-dir', routesDir, '--renderer', join(tempDir, 'missing-renderer.ts')]),
    ).resolves.toBeUndefined();
    expect(
      log.mock.calls.some(([message]) => String(message).includes('No SSG routes found')),
    ).toBe(true);
  });

  test('runCli renders routes in process and configures RSC when the renderer supports it', async () => {
    const tempDir = await makeTempDir();
    const configuredPath = join(tempDir, 'configured.json');
    const routesDir = join(tempDir, 'routes');
    const outDir = join(tempDir, 'out');
    const manifestPath = await writeFixtureFile(
      tempDir,
      'dist/client/.vite/manifest.json',
      JSON.stringify({
        'src/client/main.ts': {
          file: 'assets/app.js',
          css: ['assets/app.css'],
          isEntry: true,
        },
      }),
    );
    const rscManifestPath = await writeFixtureFile(
      tempDir,
      'dist/client/rsc-manifest.json',
      JSON.stringify({ modules: { 'src/App.tsx': { id: 'app' } } }),
    );
    const rendererPath = await writeFixtureFile(
      tempDir,
      'renderer.ts',
      `
import { writeFileSync } from 'node:fs';

export default {
  async resolve(url) {
    return {
      filePath: '/virtual/about.ts',
      metaFilePath: null,
      params: {},
      query: {},
      url,
      loadingFilePath: null,
      errorFilePath: null,
      notFoundFilePath: null,
      forbiddenFilePath: null,
      unauthorizedFilePath: null,
      templateFilePath: null,
    };
  },
  async render(match, shell) {
    return new Response(
      '<html><head>' + shell.assetTags + '</head><body>' + match.url.pathname + '</body></html>',
    );
  },
  async renderChain(chain, shell) {
    return new Response(
      '<html><head>' + shell.assetTags + '</head><body>' + chain.page.url.pathname + '</body></html>',
    );
  },
  async ssgConfigure(opts) {
    writeFileSync(${JSON.stringify(configuredPath)}, JSON.stringify(opts.rscManifest), 'utf8');
  },
};
`,
    );
    await writeFixtureFile(
      tempDir,
      'routes/about.ts',
      `export async function load() { return { data: {}, revalidate: false }; }\n`,
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});

    await runCli([
      '--routes-dir',
      routesDir,
      '--assets-manifest',
      manifestPath,
      '--out',
      outDir,
      '--renderer',
      rendererPath,
      '--rsc-manifest',
      rscManifestPath,
    ]);

    const html = await readFile(join(outDir, 'about', 'index.html'), 'utf8');
    expect(html).toContain('/assets/app.css');
    expect(html).toContain('/assets/app.js');
    expect(html).toContain('/about');
    expect(JSON.parse(await readFile(configuredPath, 'utf8'))).toEqual({
      modules: { 'src/App.tsx': { id: 'app' } },
    });
    expect(log.mock.calls.some(([message]) => String(message).includes('Done. 1 succeeded'))).toBe(
      true,
    );
  });

  test('runCli reports failed pages and exits with code 1', async () => {
    const tempDir = await makeTempDir();
    const routesDir = join(tempDir, 'routes');
    const outDir = join(tempDir, 'out');
    const rendererPath = await writeFixtureFile(
      tempDir,
      'failing-renderer.ts',
      `
export default {
  async resolve(url) {
    return {
      filePath: '/virtual/about.ts',
      metaFilePath: null,
      params: {},
      query: {},
      url,
      loadingFilePath: null,
      errorFilePath: null,
      notFoundFilePath: null,
      forbiddenFilePath: null,
      unauthorizedFilePath: null,
      templateFilePath: null,
    };
  },
  async render() {
    return new Response('fail', { status: 500 });
  },
  async renderChain() {
    return new Response('fail', { status: 500 });
  },
};
`,
    );
    await writeFixtureFile(
      tempDir,
      'routes/about.ts',
      `export async function load() { return { data: {}, revalidate: false }; }\n`,
    );
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const proc = process as unknown as { exit: (code?: number) => never };
    const originalExit = proc.exit;
    class ExitError extends Error {
      constructor(readonly code: number | undefined) {
        super(`exit ${code}`);
      }
    }
    proc.exit = ((code?: number) => {
      throw new ExitError(code);
    }) as never;

    try {
      await expect(
        runCli(['--routes-dir', routesDir, '--out', outDir, '--renderer', rendererPath]),
      ).rejects.toMatchObject({ code: 1 });
      expect(error.mock.calls.some(([message]) => String(message).includes('/about'))).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      proc.exit = originalExit;
    }
  });
});
