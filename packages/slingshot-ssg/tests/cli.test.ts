import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

const CLI_PATH = join(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const decoder = new TextDecoder();

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slingshot-ssg-cli-'));
  tempDirs.push(dir);
  return dir;
}

function writeFixtureFile(baseDir: string, relativePath: string, contents: string): string {
  const filePath = join(baseDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function createSsgFixture(baseDir: string): {
  assetsManifestPath: string;
  configuredPath: string;
  outDir: string;
  rendererWithHookPath: string;
  rendererWithoutHookPath: string;
  rscManifestPath: string;
  routesDir: string;
} {
  const routesDir = join(baseDir, 'routes');
  mkdirSync(routesDir, { recursive: true });
  writeFixtureFile(
    routesDir,
    'about.ts',
    `export async function load() { return { data: {}, revalidate: false }; }\n`,
  );

  const assetsManifestPath = writeFixtureFile(
    baseDir,
    'dist/client/.vite/manifest.json',
    JSON.stringify({
      'src/client/main.ts': {
        file: 'assets/app.js',
        isEntry: true,
      },
    }),
  );

  const configuredPath = join(baseDir, 'configured.json');
  const rendererWithHookPath = writeFixtureFile(
    baseDir,
    'renderer-with-hook.ts',
    `
import { writeFileSync } from 'node:fs';

let configuredManifest = null;

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
    return new Response('<html><body>render</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
  async renderChain() {
    return new Response('<html><body>render-chain</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
  async ssgConfigure(opts) {
    configuredManifest = opts.rscManifest ?? null;
    writeFileSync(${JSON.stringify(configuredPath)}, JSON.stringify(configuredManifest), 'utf8');
  },
};
`,
  );

  const rendererWithoutHookPath = writeFixtureFile(
    baseDir,
    'renderer-without-hook.ts',
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
    return new Response('<html><body>render</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
  async renderChain() {
    return new Response('<html><body>render-chain</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
`,
  );

  const rscManifestPath = writeFixtureFile(
    baseDir,
    'dist/client/rsc-manifest.json',
    JSON.stringify({
      modules: {
        'src/components/App.tsx': {
          id: 'app',
          chunks: ['assets/app.js'],
        },
      },
    }),
  );

  return {
    assetsManifestPath,
    configuredPath,
    outDir: join(baseDir, 'out'),
    rendererWithHookPath,
    rendererWithoutHookPath,
    rscManifestPath,
    routesDir,
  };
}

function runCli(args: string[]): { combined: string; exitCode: number } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, CLI_PATH, ...args],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    combined: decoder.decode(proc.stdout) + decoder.decode(proc.stderr),
    exitCode: proc.exitCode,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('slingshot-ssg CLI --rsc-manifest', () => {
  it('warns and continues when the manifest path does not exist', () => {
    const fixture = createSsgFixture(makeTempDir());
    const missingManifestPath = join(fixture.outDir, 'missing-rsc-manifest.json');

    const result = runCli([
      '--routes-dir',
      fixture.routesDir,
      '--assets-manifest',
      fixture.assetsManifestPath,
      '--out',
      fixture.outDir,
      '--renderer',
      fixture.rendererWithHookPath,
      '--rsc-manifest',
      missingManifestPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.combined).toContain('--rsc-manifest file not found');
    expect(existsSync(join(fixture.outDir, 'about', 'index.html'))).toBe(true);
    expect(existsSync(fixture.configuredPath)).toBe(false);
  });

  it('loads the manifest and calls ssgConfigure when the renderer implements it', () => {
    const fixture = createSsgFixture(makeTempDir());

    const result = runCli([
      '--routes-dir',
      fixture.routesDir,
      '--assets-manifest',
      fixture.assetsManifestPath,
      '--out',
      fixture.outDir,
      '--renderer',
      fixture.rendererWithHookPath,
      '--rsc-manifest',
      fixture.rscManifestPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.combined).toContain('RSC manifest loaded');
    expect(existsSync(fixture.configuredPath)).toBe(true);
    expect(JSON.parse(readFileSync(fixture.configuredPath, 'utf8'))).toEqual({
      modules: {
        'src/components/App.tsx': {
          id: 'app',
          chunks: ['assets/app.js'],
        },
      },
    });
  });

  it('warns and continues when the renderer does not implement ssgConfigure', () => {
    const fixture = createSsgFixture(makeTempDir());

    const result = runCli([
      '--routes-dir',
      fixture.routesDir,
      '--assets-manifest',
      fixture.assetsManifestPath,
      '--out',
      fixture.outDir,
      '--renderer',
      fixture.rendererWithoutHookPath,
      '--rsc-manifest',
      fixture.rscManifestPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.combined).toContain('does not implement ssgConfigure');
    expect(existsSync(join(fixture.outDir, 'about', 'index.html'))).toBe(true);
  });

  it('exits with error when outDir cannot be created (unwritable parent)', () => {
    const fixture = createSsgFixture(makeTempDir());
    const unwritableOut = '/proc/slingshot-test-unwritable/out';

    const result = runCli([
      '--routes-dir',
      fixture.routesDir,
      '--assets-manifest',
      fixture.assetsManifestPath,
      '--out',
      unwritableOut,
      '--renderer',
      fixture.rendererWithoutHookPath,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.combined).toContain('Cannot write to output directory');
  });
});
