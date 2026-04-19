import fs from 'node:fs';
import path from 'node:path';

type PublishTarget = 'github' | 'npm';

type DependencySections = Pick<
  PackageManifest,
  'dependencies' | 'optionalDependencies' | 'peerDependencies' | 'devDependencies'
>;

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  files?: string[];
  workspaces?: string[];
  scripts?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PublishablePackage = {
  name: string;
  version: string;
  sourceDir: string;
  relativeDir: string;
  stageDir: string;
  manifest: PackageManifest;
};

export interface PublishArgs {
  shouldDryRun: boolean;
  shouldPublish: boolean;
  skipExisting: boolean;
  target: PublishTarget;
}

function parseJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function sanitizeStageSegment(segment: string): string {
  return segment.replace(/[\\/]/g, '__');
}

export function parsePublishArgs(argv: string[]): PublishArgs {
  const args = new Set(argv);
  const rawTarget = [...args].find(arg => arg.startsWith('--target='))?.slice('--target='.length);
  if (rawTarget !== 'github' && rawTarget !== 'npm') {
    throw new Error(
      '[publish] Missing or invalid --target. Expected --target=github or --target=npm.',
    );
  }

  const shouldPublish = args.has('--publish');
  const shouldDryRun = args.has('--dry-run');
  if (shouldPublish && shouldDryRun) {
    throw new Error('[publish] Use either --publish or --dry-run, not both.');
  }

  return {
    target: rawTarget,
    shouldPublish,
    shouldDryRun,
    skipExisting: args.has('--skip-existing'),
  };
}

export function rewriteWorkspaceSpecifier(specifier: string, version: string): string {
  if (!specifier.startsWith('workspace:')) return specifier;

  const range = specifier.slice('workspace:'.length);
  if (range === '' || range === '*') return version;
  if (range === '^') return `^${version}`;
  if (range === '~') return `~${version}`;
  return range;
}

function rewriteDependencySection(
  section: Record<string, string> | undefined,
  sectionName: keyof DependencySections,
  versionByPackageName: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (!section) return section;

  const rewritten: Record<string, string> = {};
  for (const [dependencyName, specifier] of Object.entries(section)) {
    if (!specifier.startsWith('workspace:')) {
      rewritten[dependencyName] = specifier;
      continue;
    }

    const version = versionByPackageName.get(dependencyName);
    if (!version) {
      throw new Error(
        `[publish] ${sectionName} entry "${dependencyName}" uses "${specifier}" but no workspace version was found.`,
      );
    }
    rewritten[dependencyName] = rewriteWorkspaceSpecifier(specifier, version);
  }

  return rewritten;
}

/**
 * Strip the "bun" export condition from all export entries.
 *
 * The "bun" condition points to raw .ts source files which rely on monorepo-local
 * path aliases (e.g. @auth/*) and may sit alongside stale build artifacts.
 * Published packages should resolve through the compiled dist/ output only.
 */
export function stripBunExportCondition(
  exports: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!exports || typeof exports !== 'object') return exports;

  const cleaned: Record<string, unknown> = {};
  for (const [entrypoint, conditions] of Object.entries(exports)) {
    if (typeof conditions === 'object' && conditions !== null && !Array.isArray(conditions)) {
      const copy = { ...(conditions as Record<string, unknown>) };
      delete copy['bun'];
      cleaned[entrypoint] = copy;
    } else {
      cleaned[entrypoint] = conditions;
    }
  }
  return cleaned;
}

export function rewriteManifest(
  manifest: PackageManifest,
  targetRegistry: string,
  versionByPackageName: ReadonlyMap<string, string>,
): PackageManifest {
  const rewritten: PackageManifest = {
    ...manifest,
    publishConfig: {
      ...(manifest.publishConfig ?? {}),
      registry: targetRegistry,
      access: 'public',
    },
    dependencies: rewriteDependencySection(
      manifest.dependencies,
      'dependencies',
      versionByPackageName,
    ),
    optionalDependencies: rewriteDependencySection(
      manifest.optionalDependencies,
      'optionalDependencies',
      versionByPackageName,
    ),
    peerDependencies: rewriteDependencySection(
      manifest.peerDependencies,
      'peerDependencies',
      versionByPackageName,
    ),
    devDependencies: rewriteDependencySection(
      manifest.devDependencies,
      'devDependencies',
      versionByPackageName,
    ),
  };

  // Strip "bun" export condition — consumers should resolve through dist/, not raw src/
  if ('exports' in rewritten) {
    (rewritten as Record<string, unknown>).exports = stripBunExportCondition(
      (rewritten as Record<string, unknown>).exports as Record<string, unknown>,
    );
  }

  delete rewritten.private;
  delete rewritten.workspaces;
  delete rewritten.scripts;

  return rewritten;
}

export function collectPublishablePackages(
  rootDir: string,
  stageRoot: string,
): { packages: PublishablePackage[]; versionByPackageName: Map<string, string> } {
  const packagesDir = path.join(rootDir, 'packages');
  const versionByPackageName = new Map<string, string>();
  const packages: PublishablePackage[] = [];

  const rootManifest = parseJsonFile<PackageManifest>(path.join(rootDir, 'package.json'));
  if (!rootManifest.name || !rootManifest.version) {
    throw new Error('[publish] Root package.json must define both "name" and "version".');
  }
  versionByPackageName.set(rootManifest.name, rootManifest.version);
  packages.push({
    name: rootManifest.name,
    version: rootManifest.version,
    sourceDir: rootDir,
    relativeDir: '.',
    stageDir: path.join(stageRoot, 'root'),
    manifest: rootManifest,
  });

  const workspaceDirs = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const workspaceDir of workspaceDirs) {
    const sourceDir = path.join(packagesDir, workspaceDir);
    const manifestPath = path.join(sourceDir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = parseJsonFile<PackageManifest>(manifestPath);
    if (manifest.private) continue;
    if (!manifest.name || !manifest.version) {
      throw new Error(
        `[publish] ${workspaceDir} package.json must define both "name" and "version".`,
      );
    }

    versionByPackageName.set(manifest.name, manifest.version);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      sourceDir,
      relativeDir: path.join('packages', workspaceDir),
      stageDir: path.join(stageRoot, sanitizeStageSegment(workspaceDir)),
      manifest,
    });
  }

  return { packages, versionByPackageName };
}

function copyPathIfPresent(sourcePath: string, destPath: string, warnings: string[]): void {
  if (!fs.existsSync(sourcePath)) {
    warnings.push(`[publish] Missing file entry: ${sourcePath}`);
    return;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(sourcePath, destPath, { recursive: true, force: true });
}

export function stagePackage(
  pkg: PublishablePackage,
  options: {
    repoLicensePath: string;
    rootDir: string;
    targetRegistry: string;
    versionByPackageName: ReadonlyMap<string, string>;
  },
): string[] {
  const warnings: string[] = [];
  fs.rmSync(pkg.stageDir, { recursive: true, force: true });
  fs.mkdirSync(pkg.stageDir, { recursive: true });

  for (const entry of pkg.manifest.files ?? []) {
    const sourcePath = path.join(pkg.sourceDir, entry);
    const destPath = path.join(pkg.stageDir, entry);
    copyPathIfPresent(sourcePath, destPath, warnings);
  }

  const packageReadmePath = path.join(pkg.sourceDir, 'README.md');
  if (fs.existsSync(packageReadmePath)) {
    copyPathIfPresent(packageReadmePath, path.join(pkg.stageDir, 'README.md'), warnings);
  }

  const packageLicensePath = path.join(pkg.sourceDir, 'LICENSE');
  const licenseSource = fs.existsSync(packageLicensePath)
    ? packageLicensePath
    : options.repoLicensePath;
  if (fs.existsSync(licenseSource)) {
    copyPathIfPresent(licenseSource, path.join(pkg.stageDir, 'LICENSE'), warnings);
  }

  const stagedManifest = rewriteManifest(
    pkg.manifest,
    options.targetRegistry,
    options.versionByPackageName,
  );
  fs.writeFileSync(
    path.join(pkg.stageDir, 'package.json'),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
  );

  return warnings;
}

async function runCommand(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: command,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: process.env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

export async function packageVersionExists(
  pkg: PublishablePackage,
  targetRegistry: string,
): Promise<boolean> {
  const spec = `${pkg.name}@${pkg.version}`;
  const result = await runCommand(
    ['npm', 'view', spec, 'version', '--json', `--registry=${targetRegistry}`],
    pkg.stageDir,
  );
  return result.exitCode === 0 && result.stdout.includes(pkg.version);
}

export async function publishPackage(
  pkg: PublishablePackage,
  options: {
    dryRun: boolean;
    skipExisting: boolean;
    target: PublishTarget;
    targetRegistry: string;
  },
): Promise<void> {
  if (
    !options.dryRun &&
    options.skipExisting &&
    (await packageVersionExists(pkg, options.targetRegistry))
  ) {
    console.log(
      `[publish] Skipping ${pkg.name}@${pkg.version}; already present on ${options.target}.`,
    );
    return;
  }

  const command = ['npm', 'publish', '--access', 'public'];
  if (options.dryRun) command.push('--dry-run');

  console.log(
    `[publish] ${options.dryRun ? 'Dry-running' : 'Publishing'} ${pkg.name}@${pkg.version} to ${options.target}...`,
  );
  const result = await runCommand(command, pkg.stageDir);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new Error(
      `[publish] ${pkg.name}@${pkg.version} failed.\n${stderr || stdout || 'npm publish returned a non-zero exit code.'}`,
    );
  }
}

export async function runPublish(argv = process.argv.slice(2)): Promise<number> {
  const rootDir = process.cwd();
  const { target, shouldPublish, shouldDryRun, skipExisting } = parsePublishArgs(argv);
  const targetRegistry =
    target === 'github' ? 'https://npm.pkg.github.com' : 'https://registry.npmjs.org';
  const stageRoot = path.join(rootDir, '.tmp', 'publish', target);
  const repoLicensePath = path.join(rootDir, 'LICENSE');
  const { packages: publishablePackages, versionByPackageName } = collectPublishablePackages(
    rootDir,
    stageRoot,
  );

  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });

  const warnings: string[] = [];
  for (const pkg of publishablePackages) {
    warnings.push(
      ...stagePackage(pkg, {
        repoLicensePath,
        rootDir,
        targetRegistry,
        versionByPackageName,
      }),
    );
  }

  console.log(
    `[publish] Staged ${publishablePackages.length} package(s) for ${target} in ${path.relative(rootDir, stageRoot)}`,
  );
  for (const warning of warnings) {
    console.warn(warning);
  }

  if (shouldPublish || shouldDryRun) {
    for (const pkg of publishablePackages) {
      await publishPackage(pkg, {
        dryRun: shouldDryRun,
        skipExisting,
        target,
        targetRegistry,
      });
    }
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await runPublish());
}
