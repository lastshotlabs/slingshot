import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { WorkspacePackage } from '../workspacePackages';

const tmpRoot = join(import.meta.dir, '.tmp-docs-sync');

function makePackageFixture(): WorkspacePackage {
  const packageDir = join(tmpRoot, 'packages', 'fixture');
  const docsSourceDir = join(packageDir, 'docs');
  const srcDir = join(packageDir, 'src');

  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(docsSourceDir, 'human', 'guides'), { recursive: true });
  mkdirSync(join(docsSourceDir, 'notes'), { recursive: true });

  writeFileSync(join(srcDir, 'index.ts'), 'export const fixture = true;\n', 'utf8');
  writeFileSync(
    join(docsSourceDir, 'human', 'index.md'),
    [
      '---',
      'title: "Fixture Guide"',
      '---',
      '',
      'Fixture package overview paragraph.',
      '',
      '## Usage',
      '',
      '- Real setup details live here.',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(docsSourceDir, 'human', 'guides', 'setup.md'), 'Use the fixture package.\n');
  writeFileSync(join(docsSourceDir, 'notes', 'private.md'), 'skip me\n', 'utf8');

  return {
    kind: 'workspace',
    slug: 'fixture-package',
    name: '@lastshotlabs/fixture-package',
    version: '1.2.3',
    description: 'Fixture package for docs sync testing.',
    packageJsonPath: join(packageDir, 'package.json'),
    packageDir,
    relativeDir: 'packages/fixture',
    entryPoint: join(srcDir, 'index.ts'),
    docsSourceDir,
    exports: ['.'],
    scripts: { build: 'bun test' },
    dependencies: { zod: '^3.0.0' },
    peerDependencies: {},
  };
}

afterEach(() => {
  mock.restore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('docs coverage report', () => {
  test('runs against the real workspace and prints the coverage summary', async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { main } = await import('../coverage-docs');
    const exitCode = await main();

    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Documentation Coverage Report');
    expect(logs.join('\n')).toContain('JSDoc coverage:');
  });
});

describe('sync-workspace-docs', () => {
  test('writes synced docs into a caller-provided output tree and skips private notes', async () => {
    const fixturePackage = makePackageFixture();
    const outputRootPath = join(tmpRoot, 'output');
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const { main } = await import('../sync-workspace-docs');
    await main({ packages: [fixturePackage], outputRootPath });

    logSpy.mockRestore();

    const packageOutputDir = join(outputRootPath, fixturePackage.slug);
    expect(existsSync(join(outputRootPath, 'index.mdx'))).toBe(true);
    expect(existsSync(join(packageOutputDir, 'index.mdx'))).toBe(true);
    expect(existsSync(join(packageOutputDir, 'overview.md'))).toBe(true);
    expect(existsSync(join(packageOutputDir, 'guides', 'guides', 'setup.md'))).toBe(true);
    expect(existsSync(join(packageOutputDir, 'maintainer-notes', 'private.md'))).toBe(false);
    expect(logs).toContain(`Synced docs: ${fixturePackage.name}`);

    const packageIndex = readFileSync(join(packageOutputDir, 'index.mdx'), 'utf8');
    const guideOverview = readFileSync(join(packageOutputDir, 'overview.md'), 'utf8');

    expect(packageIndex).toContain('Fixture package overview paragraph.');
    expect(packageIndex).toContain(`bun add ${fixturePackage.name}`);
    expect(guideOverview).toContain('title: "Overview"');
    expect(guideOverview).toContain('Fixture package overview paragraph.');
  });
});

describe('docs content config', () => {
  test('registers the docs collection with Astro content', async () => {
    const docsSchemaToken = Symbol('docsSchema');

    mock.module('@astrojs/starlight/schema', () => ({
      docsSchema: () => docsSchemaToken,
    }));

    mock.module('astro:content', () => ({
      defineCollection: ({ schema }: { schema: unknown }) => ({ schema, kind: 'collection' }),
    }));

    const mod = await import('../src/content.config');
    const docsCollection = mod.collections.docs as unknown as {
      schema: unknown;
      kind: string;
    };

    expect(docsCollection.kind).toBe('collection');
    expect(docsCollection.schema).toBe(docsSchemaToken);
  });
});
