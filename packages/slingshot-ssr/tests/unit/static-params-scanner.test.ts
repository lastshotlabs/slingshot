import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  type StaticRoute,
  scanStaticParams,
  writeStaticParamsManifest,
} from '../../src/static-params/index';

describe('static params scanner', () => {
  test('discovers generateStaticParams exports and derives route paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'slingshot-static-params-'));

    try {
      const routesDir = join(tempDir, 'routes');
      const postDir = join(routesDir, 'posts', '[id]');
      const aboutDir = join(routesDir, '(marketing)', 'about');
      await mkdir(postDir, { recursive: true });
      await mkdir(aboutDir, { recursive: true });
      await writeFile(
        join(postDir, 'page.ts'),
        [
          'export async function generateStaticParams(ctx) {',
          '  if (ctx.draftMode().isEnabled) throw new Error("draft mode should be disabled");',
          '  return [{ id: "1" }, { id: "2" }];',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(aboutDir, 'page.ts'),
        'export async function generateStaticParams() { return [{}]; }\n',
        'utf8',
      );
      await writeFile(join(routesDir, 'ignored.ts'), 'export const value = true;\n', 'utf8');

      const routes = (await scanStaticParams(routesDir)).sort((left, right) =>
        left.routePath.localeCompare(right.routePath),
      );

      expect(routes.map(route => route.routePath)).toEqual(['/about', '/posts/[id]']);
      expect(routes.find(route => route.routePath === '/posts/[id]')?.paramSets).toEqual([
        { id: '1' },
        { id: '2' },
      ]);
      expect(Object.isFrozen(routes[0])).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('writes a deployable manifest without build-machine file paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'slingshot-static-manifest-'));

    try {
      const routes: StaticRoute[] = [
        {
          routePath: '/posts/[id]',
          filePath: join(tempDir, 'routes', 'posts', '[id]', 'page.ts'),
          paramSets: [{ id: '1' }],
        },
      ];

      await writeStaticParamsManifest(routes, join(tempDir, 'dist'));

      const source = await readFile(join(tempDir, 'dist', 'static-params.json'), 'utf8');
      expect(JSON.parse(source)).toEqual([{ routePath: '/posts/[id]', paramSets: [{ id: '1' }] }]);
      expect(source).not.toContain('filePath');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
