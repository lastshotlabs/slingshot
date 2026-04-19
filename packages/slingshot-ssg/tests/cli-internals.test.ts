import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { loadRenderer, parseArgs, resolveAssetTagsHtml } from '../src/cli';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slingshot-ssg-cli-unit-'));
  tempDirs.push(dir);
  return dir;
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
    });
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
});
