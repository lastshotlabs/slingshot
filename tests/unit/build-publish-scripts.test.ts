import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

describe('build and publish scripts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rewrites framework declaration imports and preserves requested build outputs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-build-script-'));
    tempDirs.push(tempDir);

    const frameworkDir = join(tempDir, 'dist', 'src', 'framework');
    const nestedDir = join(frameworkDir, 'nested');
    const cleanDir = join(tempDir, 'clean-target');
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(cleanDir, 'keep'), { recursive: true });
    mkdirSync(join(cleanDir, 'remove-me'), { recursive: true });

    writeFileSync(
      join(nestedDir, 'types.d.ts'),
      ['export * from "@config/app.js";', 'export * from "@lib/helpers.js";', ''].join('\n'),
      'utf8',
    );
    writeFileSync(join(cleanDir, 'keep', 'file.txt'), 'keep\n', 'utf8');
    writeFileSync(join(cleanDir, 'remove-me', 'file.txt'), 'remove\n', 'utf8');

    const buildModule = await import('../../scripts/build');
    buildModule.rewriteFrameworkDeclarationImports(frameworkDir);
    buildModule.cleanTarget({ path: cleanDir, preserveEntries: ['keep'] });

    const rewritten = readFileSync(join(nestedDir, 'types.d.ts'), 'utf8');
    expect(rewritten).toContain('../../config/app.js');
    expect(rewritten).toContain('../../lib/helpers.js');
    expect(rewritten).not.toContain('@config/');
    expect(rewritten).not.toContain('@lib/');
    expect(existsSync(join(cleanDir, 'keep', 'file.txt'))).toBe(true);
    expect(existsSync(join(cleanDir, 'remove-me'))).toBe(false);

    const readme = buildModule.renderPackageReadme(
      '---\ntitle: Human Guide\ndescription: Package docs\n---\n\nPackage body.\n',
      '@acme/demo',
    );
    expect(readme).toStartWith('# @acme/demo\n');
    expect(readme).toContain('bun add @acme/demo');
    expect(readme).toContain('Package body.');
    expect(readme).not.toContain('title: Human Guide');
  });

  test('parses publish args, rewrites manifests, and stages publishable packages', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-publish-script-'));
    tempDirs.push(tempDir);

    const stageRoot = join(tempDir, '.tmp', 'publish', 'npm');
    const packageDir = join(tempDir, 'packages', 'demo');
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(tempDir, 'LICENSE'), 'MIT\n', 'utf8');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'slingshot-root', version: '1.2.3', files: ['dist'] }),
      'utf8',
    );
    writeFileSync(join(packageDir, 'README.md'), '# demo\n', 'utf8');
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export const demo = true;\n', 'utf8');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@acme/demo',
        version: '0.4.0',
        files: ['dist'],
        private: false,
        scripts: { build: 'bun run build' },
        dependencies: { 'slingshot-root': 'workspace:^' },
        exports: {
          '.': {
            bun: './src/index.ts',
            import: './dist/index.js',
          },
        },
      }),
      'utf8',
    );

    const publishModule = await import('../../scripts/publish');
    expect(publishModule.parsePublishArgs(['--target=npm', '--dry-run'])).toEqual({
      target: 'npm',
      shouldPublish: false,
      shouldDryRun: true,
      skipExisting: false,
    });
    expect(publishModule.rewriteWorkspaceSpecifier('workspace:^', '1.2.3')).toBe('^1.2.3');

    const { packages, versionByPackageName } = publishModule.collectPublishablePackages(
      tempDir,
      stageRoot,
    );
    expect(packages.map((pkg: { name: string }) => pkg.name)).toContain('@acme/demo');

    const demoPackage = packages.find((pkg: { name: string }) => pkg.name === '@acme/demo');
    expect(demoPackage).toBeDefined();

    const warnings = publishModule.stagePackage(demoPackage!, {
      repoLicensePath: join(tempDir, 'LICENSE'),
      rootDir: tempDir,
      targetRegistry: 'https://registry.npmjs.org',
      versionByPackageName,
    });
    expect(warnings).toEqual([]);

    const stagedManifest = JSON.parse(
      readFileSync(join(demoPackage!.stageDir, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      exports: Record<string, { bun?: string; import?: string }>;
      publishConfig: { registry: string; access: string };
      scripts?: Record<string, string>;
    };

    expect(stagedManifest.dependencies['slingshot-root']).toBe('^1.2.3');
    expect(stagedManifest.exports['.'].bun).toBeUndefined();
    expect(stagedManifest.exports['.'].import).toBe('./dist/index.js');
    expect(stagedManifest.publishConfig.registry).toBe('https://registry.npmjs.org');
    expect(stagedManifest.publishConfig.access).toBe('public');
    expect(stagedManifest.scripts).toBeUndefined();
    expect(readFileSync(join(demoPackage!.stageDir, 'README.md'), 'utf8')).toContain('# demo');
    expect(readFileSync(join(demoPackage!.stageDir, 'LICENSE'), 'utf8')).toContain('MIT');
    expect(existsSync(join(demoPackage!.stageDir, 'dist', 'index.js'))).toBe(true);
  });

  test('detects undeclared emitted imports and missing packed export targets', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-packed-artifact-'));
    tempDirs.push(tempDir);

    const stageDir = join(tempDir, 'stage');
    mkdirSync(join(stageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(stageDir, 'package.json'),
      JSON.stringify({
        name: '@acme/demo',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(stageDir, 'dist', 'index.js'),
      [
        "import { declared } from '@acme/declared';",
        "const runtime = import('@acme/missing/runtime');",
        'export { declared, runtime };',
        '',
      ].join('\n'),
      'utf8',
    );

    const verifier = await import('../../scripts/verify-packed-artifacts');
    expect(
      verifier.extractPackageImports(readFileSync(join(stageDir, 'dist', 'index.js'), 'utf8')),
    ).toEqual(new Set(['@acme/declared', '@acme/missing/runtime']));

    const integrityErrors = verifier.findStageIntegrityErrors(
      stageDir,
      {
        name: '@acme/demo',
        dependencies: { '@acme/declared': '^1.0.0' },
      },
      tempDir,
    );
    expect(integrityErrors).toContain('dist/index.js imports undeclared package "@acme/missing"');

    const manifestErrors = verifier.findPackedManifestErrors(
      {
        name: '@acme/demo',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
      },
      new Set(['dist/index.js']),
    );
    expect(manifestErrors).toEqual([
      'manifest target "./dist/index.d.ts" is absent from the tarball',
    ]);
    expect(
      verifier.publicImportSpecifiers({
        name: '@acme/demo',
        exports: {
          '.': { import: './dist/index.js' },
          './testing': { import: './dist/testing.js' },
          './schema.json': './dist/schema.json',
        },
      }),
    ).toEqual(['@acme/demo', '@acme/demo/testing']);
  });
});
