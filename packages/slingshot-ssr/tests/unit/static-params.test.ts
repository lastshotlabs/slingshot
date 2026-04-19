import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  scanStaticParams,
  writeStaticParamsManifest,
} from '../../src/static-params/index';
import {
  buildConcreteUrl,
  createPrerenderedCache,
  getPrerenderedHtml,
  prerenderStaticRoutes,
} from '../../src/static-params/prerender';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slingshot-ssr-static-params-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('static params helpers', () => {
  test('scanStaticParams discovers route files and writeStaticParamsManifest serializes them', async () => {
    const routesDir = await makeTempDir();
    const routeFile = join(routesDir, 'players', '[id].ts');

    await mkdir(join(routesDir, 'players'), { recursive: true });
    await writeFile(
      routeFile,
      "export async function generateStaticParams() { return [{ id: '42' }, { id: '99' }]; }\n",
      'utf8',
    );

    const routes = await scanStaticParams(routesDir);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routePath: '/players/[id]',
      filePath: routeFile,
      paramSets: [{ id: '42' }, { id: '99' }],
    });

    const outputDir = join(routesDir, 'dist');
    await writeStaticParamsManifest(routes, outputDir);

    expect(
      JSON.parse(await readFile(join(outputDir, 'static-params.json'), 'utf8')),
    ).toEqual([
      {
        routePath: '/players/[id]',
        paramSets: [{ id: '42' }, { id: '99' }],
      },
    ]);
  });

  test('prerender helpers build concrete URLs and cache rendered HTML', async () => {
    const cache = createPrerenderedCache();

    expect(buildConcreteUrl('/blog/[...slug]', { slug: 'news/latest' })).toBe(
      '/blog/news/latest',
    );

    await prerenderStaticRoutes(
      [
        {
          routePath: '/players/[id]',
          filePath: '/virtual/players/[id].ts',
          paramSets: [{ id: '42' }],
        },
      ],
      async path => `<html>${path}</html>`,
      cache,
    );

    expect(getPrerenderedHtml(cache, '/players/42')).toBe('<html>/players/42</html>');
    expect(cache.entries()).toEqual([
      {
        path: '/players/42',
        html: '<html>/players/42</html>',
      },
    ]);
  });
});
