import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

interface PackageManifest {
  name?: string;
  private?: boolean;
  files?: string[];
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
}

interface ExportTarget {
  path: string;
  target: string;
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function workspacePackages(): Array<{ dir: string; manifest: PackageManifest }> {
  const packagesDir = join(process.cwd(), 'packages');
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const manifestPath = join(packagesDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) return null;
      return { dir: entry.name, manifest: readJson(manifestPath) };
    })
    .filter((entry): entry is { dir: string; manifest: PackageManifest } => entry != null)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function collectExportTargets(value: unknown, path = 'exports'): ExportTarget[] {
  if (typeof value === 'string') return [{ path, target: value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectExportTargets(entry, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) =>
      collectExportTargets(nested, `${path}.${key}`),
    );
  }
  return [];
}

function collectBinTargets(bin: PackageManifest['bin']): ExportTarget[] {
  if (typeof bin === 'string') return [{ path: 'bin', target: bin }];
  if (bin && typeof bin === 'object') {
    return Object.entries(bin).map(([name, target]) => ({ path: `bin.${name}`, target }));
  }
  return [];
}

function targetIsPackaged(target: string, files: string[]): boolean {
  if (!target.startsWith('./')) return true;
  const normalized = target.slice(2);
  return files.some(entry => normalized === entry || normalized.startsWith(`${entry}/`));
}

describe('package metadata', () => {
  test('root package exports point at emitted source artifacts', () => {
    const manifest = readJson(join(process.cwd(), 'package.json'));
    const offenders: string[] = [];

    for (const { path, target } of collectExportTargets(manifest.exports)) {
      if (!target.startsWith('./dist/')) continue;
      const sourceTarget = target
        .slice('./dist/'.length)
        .replace(/\.d\.ts$/, '.ts')
        .replace(/\.js$/, '.ts');
      if (!existsSync(join(process.cwd(), sourceTarget))) {
        offenders.push(`${path} -> ${target} has no source file ${sourceTarget}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('publishable workspace packages do not expose raw source runtime targets', () => {
    const offenders: string[] = [];

    for (const { dir, manifest } of workspacePackages()) {
      if (manifest.private === true) continue;
      const files = manifest.files ?? [];
      if (!files.includes('dist')) continue;

      const targets = [
        ...collectExportTargets(manifest.exports),
        ...collectBinTargets(manifest.bin),
      ];

      for (const { path, target } of targets) {
        if (target.startsWith('./src/')) {
          offenders.push(`${dir}:${path} -> ${target}`);
        }
        if (target.endsWith('.ts') && !target.endsWith('.d.ts')) {
          offenders.push(`${dir}:${path} -> ${target}`);
        }
        if (!targetIsPackaged(target, files)) {
          offenders.push(`${dir}:${path} -> ${target} is outside files[]`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('publishable package build scripts emit artifacts instead of typechecking only', () => {
    const offenders = workspacePackages()
      .filter(({ manifest }) => manifest.private !== true)
      .filter(({ manifest }) => (manifest.files ?? []).includes('dist'))
      .filter(({ manifest }) => manifest.scripts?.build?.includes('tsc --noEmit'))
      .map(({ dir }) => dir);

    expect(offenders).toEqual([]);
  });

  test('root release scripts run hardening and preserve Docker cleanup exit codes', () => {
    const rootManifest = readJson(join(process.cwd(), 'package.json'));
    const scripts = rootManifest.scripts ?? {};

    expect(scripts.prepublishOnly).toBe('bun run hardening:full');
    expect(scripts.release).toStartWith('bun run hardening:full &&');
    expect(scripts['hardening:full']).toContain('bun run test:coverage:check');
    expect(scripts['test:docker']).toContain('code=$?; bun run test:docker:down; exit $code');
    expect(scripts['test:e2e']).toContain('code=$?; bun run test:docker:down; exit $code');
    expect(scripts['test:coverage:full']).toContain(
      'code=$?; bun run test:docker:down; exit $code',
    );
  });
});
