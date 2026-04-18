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

const ROOT_DIR = process.cwd();
const PACKAGES_DIR = path.join(ROOT_DIR, 'packages');
const args = new Set(process.argv.slice(2));

const rawTarget = [...args].find(arg => arg.startsWith('--target='))?.slice('--target='.length);
if (rawTarget !== 'github' && rawTarget !== 'npm') {
  throw new Error(
    '[publish] Missing or invalid --target. Expected --target=github or --target=npm.',
  );
}

const target: PublishTarget = rawTarget;
const shouldPublish = args.has('--publish');
const shouldDryRun = args.has('--dry-run');
const skipExisting = args.has('--skip-existing');

if (shouldPublish && shouldDryRun) {
  throw new Error('[publish] Use either --publish or --dry-run, not both.');
}

const targetRegistry =
  target === 'github' ? 'https://npm.pkg.github.com' : 'https://registry.npmjs.org';
const stageRoot = path.join(ROOT_DIR, '.tmp', 'publish', target);
const repoLicensePath = path.join(ROOT_DIR, 'LICENSE');

const versionByPackageName = new Map<string, string>();

function parseJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function sanitizeStageSegment(segment: string): string {
  return segment.replace(/[\\/]/g, '__');
}

function rewriteWorkspaceSpecifier(specifier: string, version: string): string {
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

function rewriteManifest(manifest: PackageManifest): PackageManifest {
  const rewritten: PackageManifest = {
    ...manifest,
    publishConfig: {
      ...(manifest.publishConfig ?? {}),
      registry: targetRegistry,
      access: 'public',
    },
    dependencies: rewriteDependencySection(manifest.dependencies, 'dependencies'),
    optionalDependencies: rewriteDependencySection(
      manifest.optionalDependencies,
      'optionalDependencies',
    ),
    peerDependencies: rewriteDependencySection(manifest.peerDependencies, 'peerDependencies'),
    devDependencies: rewriteDependencySection(manifest.devDependencies, 'devDependencies'),
  };

  delete rewritten.private;
  delete rewritten.workspaces;
  delete rewritten.scripts;

  return rewritten;
}

function collectPublishablePackages(): PublishablePackage[] {
  const packages: PublishablePackage[] = [];

  const rootManifest = parseJsonFile<PackageManifest>(path.join(ROOT_DIR, 'package.json'));
  if (!rootManifest.name || !rootManifest.version) {
    throw new Error('[publish] Root package.json must define both "name" and "version".');
  }
  versionByPackageName.set(rootManifest.name, rootManifest.version);
  packages.push({
    name: rootManifest.name,
    version: rootManifest.version,
    sourceDir: ROOT_DIR,
    relativeDir: '.',
    stageDir: path.join(stageRoot, 'root'),
    manifest: rootManifest,
  });

  const workspaceDirs = fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const workspaceDir of workspaceDirs) {
    const sourceDir = path.join(PACKAGES_DIR, workspaceDir);
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

  return packages;
}

function copyPathIfPresent(sourcePath: string, destPath: string, warnings: string[]): void {
  if (!fs.existsSync(sourcePath)) {
    warnings.push(`[publish] Missing file entry: ${path.relative(ROOT_DIR, sourcePath)}`);
    return;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(sourcePath, destPath, { recursive: true, force: true });
}

function stagePackage(pkg: PublishablePackage): string[] {
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
  const licenseSource = fs.existsSync(packageLicensePath) ? packageLicensePath : repoLicensePath;
  if (fs.existsSync(licenseSource)) {
    copyPathIfPresent(licenseSource, path.join(pkg.stageDir, 'LICENSE'), warnings);
  }

  const stagedManifest = rewriteManifest(pkg.manifest);
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

async function packageVersionExists(pkg: PublishablePackage): Promise<boolean> {
  const spec = `${pkg.name}@${pkg.version}`;
  const result = await runCommand(
    ['npm', 'view', spec, 'version', '--json', `--registry=${targetRegistry}`],
    pkg.stageDir,
  );
  return result.exitCode === 0 && result.stdout.includes(pkg.version);
}

async function publishPackage(pkg: PublishablePackage, dryRun: boolean): Promise<void> {
  if (!dryRun && skipExisting && (await packageVersionExists(pkg))) {
    console.log(`[publish] Skipping ${pkg.name}@${pkg.version}; already present on ${target}.`);
    return;
  }

  const command = ['npm', 'publish', '--access', 'public'];
  if (dryRun) command.push('--dry-run');

  console.log(
    `[publish] ${dryRun ? 'Dry-running' : 'Publishing'} ${pkg.name}@${pkg.version} to ${target}...`,
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

const publishablePackages = collectPublishablePackages();
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });

const warnings: string[] = [];
for (const pkg of publishablePackages) {
  warnings.push(...stagePackage(pkg));
}

console.log(
  `[publish] Staged ${publishablePackages.length} package(s) for ${target} in ${path.relative(ROOT_DIR, stageRoot)}`,
);
for (const warning of warnings) {
  console.warn(warning);
}

if (shouldPublish || shouldDryRun) {
  for (const pkg of publishablePackages) {
    await publishPackage(pkg, shouldDryRun);
  }
}
