import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(__dirname, '../..');
export const docsPackageRoot = resolve(repoRoot, 'packages/docs');

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  exports?: Record<string, unknown> | string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  kind: 'root' | 'workspace';
  slug: string;
  name: string;
  version: string;
  description: string;
  packageJsonPath: string;
  packageDir: string;
  relativeDir: string;
  entryPoint: string;
  docsSourceDir: string;
  exports: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

function readPackageJson(filePath: string): PackageJson {
  return JSON.parse(readFileSync(filePath, 'utf8')) as PackageJson;
}

function toSlug(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '').replace(/[\/]/g, '-');
}

function ensureTrailingDescription(description: string): string {
  return description.trim() || 'Package documentation for this Slingshot workspace module.';
}

function packageEntryFromJson(
  kind: WorkspacePackage['kind'],
  packageDir: string,
  relativeDir: string,
  docsSourceDir: string,
): WorkspacePackage | null {
  const packageJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return null;

  const packageJson = readPackageJson(packageJsonPath);
  const name = packageJson.name?.trim();
  if (!name) return null;

  const entryPoint = resolve(packageDir, 'src/index.ts');
  if (!existsSync(entryPoint)) return null;

  return {
    kind,
    slug: toSlug(name),
    name,
    version: packageJson.version?.trim() || '0.0.0',
    description: ensureTrailingDescription(packageJson.description || ''),
    packageJsonPath,
    packageDir,
    relativeDir,
    entryPoint,
    docsSourceDir,
    exports:
      typeof packageJson.exports === 'string'
        ? ['.']
        : Object.keys(packageJson.exports || {}).sort((a, b) => a.localeCompare(b)),
    scripts: packageJson.scripts || {},
    dependencies: packageJson.dependencies || {},
    peerDependencies: packageJson.peerDependencies || {},
  };
}

export function discoverWorkspacePackages(): WorkspacePackage[] {
  const entries: WorkspacePackage[] = [];

  const rootPackage = packageEntryFromJson(
    'root',
    repoRoot,
    '.',
    resolve(repoRoot, 'docs/package'),
  );
  if (rootPackage) {
    entries.push(rootPackage);
  }

  const packagesDir = resolve(repoRoot, 'packages');
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packageDir = resolve(packagesDir, entry.name);
    const workspacePackage = packageEntryFromJson(
      'workspace',
      packageDir,
      `packages/${entry.name}`,
      resolve(packageDir, 'docs'),
    );
    if (!workspacePackage) continue;

    entries.push(workspacePackage);
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
