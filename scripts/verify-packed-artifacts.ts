import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import {
  type PackageManifest,
  type PublishablePackage,
  collectPublishablePackages,
  stagePackage,
} from './publish';

const NPM_REGISTRY = 'https://registry.npmjs.org';
const ROOT_PACKAGE = '@lastshotlabs/slingshot';
const NODE_RUNTIME_PACKAGE = '@lastshotlabs/slingshot-runtime-node';
const EMITTED_CODE = /\.(?:[cm]?js|d\.[cm]?ts)$/;
const SOURCE_ALIAS =
  /^@(?:admin|app|auth|config|framework|lib|queues|routes|scripts|workers)(?:\/|$)/;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PackedArtifact = {
  pkg: PublishablePackage;
  manifest: PackageManifest;
  tarballPath: string;
  files: ReadonlySet<string>;
};

type NpmPackResult = {
  filename: string;
  files: Array<{ path: string }>;
};

async function runCommand(command: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: command,
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function walkFiles(rootDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function packageNameFromSpecifier(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier;
  return specifier.split('/').slice(0, 2).join('/');
}

/**
 * Extract package imports from emitted JavaScript and declarations. This is
 * intentionally syntax-shaped instead of a generic string search so examples
 * and error messages containing `import "..."` do not become dependencies.
 */
export function extractPackageImports(source: string): ReadonlySet<string> {
  const specifiers = new Set<string>();
  const withoutShebang = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
  const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(withoutShebang);
  for (const { path: specifier } of imports) {
    if (
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('bun:') &&
      !isBuiltin(specifier)
    ) {
      specifiers.add(specifier);
    }
  }
  return specifiers;
}

function declaredPackageNames(manifest: PackageManifest): ReadonlySet<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

export function findStageIntegrityErrors(
  stageDir: string,
  manifest: PackageManifest,
  repoRoot: string,
): string[] {
  const errors: string[] = [];
  const declared = declaredPackageNames(manifest);
  const manifestText = readFileSync(join(stageDir, 'package.json'), 'utf8');
  if (manifestText.includes('workspace:')) {
    errors.push('staged manifest still contains a workspace: dependency');
  }

  for (const filePath of walkFiles(stageDir)) {
    const relativePath = relative(stageDir, filePath);
    if (!EMITTED_CODE.test(relativePath)) continue;
    const source = readFileSync(filePath, 'utf8');

    if (source.includes(repoRoot)) {
      errors.push(`${relativePath} contains the absolute workspace path`);
    }

    if (!relativePath.endsWith('.d.ts')) {
      for (const specifier of extractPackageImports(source)) {
        const dependencyName = packageNameFromSpecifier(specifier);
        if (dependencyName === manifest.name) continue;
        if (SOURCE_ALIAS.test(specifier)) {
          errors.push(`${relativePath} contains unresolved source alias "${specifier}"`);
        } else if (!declared.has(dependencyName)) {
          errors.push(`${relativePath} imports undeclared package "${dependencyName}"`);
        }
      }
    } else {
      for (const match of source.matchAll(
        /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1];
        if (specifier && SOURCE_ALIAS.test(specifier)) {
          errors.push(`${relativePath} contains unresolved source alias "${specifier}"`);
        }
      }
    }

    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"](\.[^'"]+\.ts)['"]/g,
    )) {
      errors.push(`${relativePath} imports TypeScript source "${match[1]}"`);
    }
  }

  return [...new Set(errors)].sort();
}

function collectExportTargets(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectExportTargets);
}

function normalizePackedPath(target: string): string {
  return target.replace(/^\.\//, '').replaceAll('\\', '/');
}

function findRootPackedSurfaceErrors(artifact: PackedArtifact, rootDir: string): string[] {
  const errors: string[] = [];
  if (!artifact.files.has('README.md')) {
    errors.push('README.md is absent from the tarball');
  } else if (
    readFileSync(join(artifact.pkg.stageDir, 'README.md'), 'utf8') !==
    readFileSync(join(rootDir, 'README.md'), 'utf8')
  ) {
    errors.push('packed README.md does not match the repository README');
  }

  const commandRoot = join(rootDir, 'src', 'cli', 'commands');
  const commandSources = walkFiles(commandRoot).filter(path => path.endsWith('.ts'));
  const expectedCommandIds = new Set(
    commandSources.map(path =>
      relative(commandRoot, path).replace(/\.ts$/, '').replaceAll('\\', ':').replaceAll('/', ':'),
    ),
  );
  for (const sourcePath of commandSources) {
    const outputPath = `dist/cli/commands/${relative(commandRoot, sourcePath)
      .replace(/\.ts$/, '.js')
      .replaceAll('\\', '/')}`;
    if (!artifact.files.has(outputPath)) {
      errors.push(`CLI command output "${outputPath}" is absent from the tarball`);
    }
  }
  if (!artifact.files.has('dist/cli/dev-runner.js')) {
    errors.push('CLI dev runner is absent from the tarball');
  }

  const manifest = JSON.parse(
    readFileSync(join(artifact.pkg.stageDir, '.oclif.manifest.json'), 'utf8'),
  ) as {
    commands?: Record<string, { id?: string }> | Array<{ id?: string }>;
  };
  const commands = Array.isArray(manifest.commands)
    ? manifest.commands
    : Object.values(manifest.commands ?? {});
  const actualCommandIds = new Set(commands.flatMap(command => (command.id ? [command.id] : [])));
  for (const id of expectedCommandIds) {
    if (!actualCommandIds.has(id)) {
      errors.push(`CLI command "${id}" is absent from the packed oclif manifest`);
    }
  }
  if (actualCommandIds.size !== expectedCommandIds.size) {
    errors.push(
      `packed oclif manifest has ${actualCommandIds.size} commands; expected ${expectedCommandIds.size}`,
    );
  }
  return errors;
}

export function findPackedManifestErrors(
  manifest: PackageManifest,
  packedFiles: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const targets = [
    ...(manifest.main ? [manifest.main] : []),
    ...(manifest.module ? [manifest.module] : []),
    ...(manifest.types ? [manifest.types] : []),
    ...collectExportTargets(manifest.exports),
    ...(typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})),
  ];

  for (const target of targets) {
    const normalized = normalizePackedPath(target);
    if (normalized.includes('*')) continue;
    if (!packedFiles.has(normalized)) {
      errors.push(`manifest target "${target}" is absent from the tarball`);
    }
  }
  return [...new Set(errors)].sort();
}

function selectImportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of ['node', 'import', 'default']) {
    const selected = selectImportTarget(conditions[condition]);
    if (selected) return selected;
  }
  return null;
}

export function publicImportSpecifiers(manifest: PackageManifest): string[] {
  if (!manifest.name) return [];
  if (!manifest.exports) return [manifest.name];

  const specifiers: string[] = [];
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    if (subpath.includes('*')) continue;
    const target = selectImportTarget(value);
    if (!target || target.endsWith('.json')) continue;
    specifiers.push(subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`);
  }
  return specifiers;
}

function workspaceClosure(
  targetName: string,
  artifactsByName: ReadonlyMap<string, PackedArtifact>,
  extraNames: readonly string[] = [],
  includeOptional = false,
): ReadonlySet<string> {
  const closure = new Set<string>();
  const queue = [targetName, ...extraNames];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    const artifact = artifactsByName.get(name);
    if (!artifact) continue;
    closure.add(name);

    for (const dependencyName of Object.keys(artifact.manifest.dependencies ?? {})) {
      if (artifactsByName.has(dependencyName)) queue.push(dependencyName);
    }
    if (includeOptional) {
      for (const dependencyName of Object.keys(artifact.manifest.optionalDependencies ?? {})) {
        if (artifactsByName.has(dependencyName)) queue.push(dependencyName);
      }
    }
    for (const [peerName] of Object.entries(artifact.manifest.peerDependencies ?? {})) {
      const optional = artifact.manifest.peerDependenciesMeta?.[peerName]?.optional === true;
      if ((includeOptional || !optional) && artifactsByName.has(peerName)) {
        queue.push(peerName);
      }
    }
  }
  return closure;
}

function requiredExternalPeers(
  workspaceNames: ReadonlySet<string>,
  artifactsByName: ReadonlyMap<string, PackedArtifact>,
  includeOptional = false,
): Record<string, string> {
  const peers: Record<string, string> = {};
  for (const workspaceName of workspaceNames) {
    const manifest = artifactsByName.get(workspaceName)!.manifest;
    for (const [peerName, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (
        !artifactsByName.has(peerName) &&
        (includeOptional || manifest.peerDependenciesMeta?.[peerName]?.optional !== true)
      ) {
        peers[peerName] ??= range;
      }
    }
  }
  return peers;
}

async function packStage(pkg: PublishablePackage): Promise<PackedArtifact> {
  const result = await runCommand(['npm', 'pack', '--json', '--ignore-scripts'], pkg.stageDir);
  if (result.exitCode !== 0) {
    throw new Error(
      `[packed-artifacts] npm pack failed for ${pkg.name}:\n${result.stderr || result.stdout}`,
    );
  }

  let packed: NpmPackResult;
  try {
    [packed] = JSON.parse(result.stdout) as NpmPackResult[];
  } catch {
    throw new Error(
      `[packed-artifacts] npm pack returned invalid JSON for ${pkg.name}:\n${result.stdout}`,
    );
  }
  if (!packed?.filename) {
    throw new Error(`[packed-artifacts] npm pack returned no tarball for ${pkg.name}.`);
  }

  const manifest = JSON.parse(
    readFileSync(join(pkg.stageDir, 'package.json'), 'utf8'),
  ) as PackageManifest;
  return {
    pkg,
    manifest,
    tarballPath: resolve(pkg.stageDir, packed.filename),
    files: new Set(packed.files.map(file => file.path.replace(/^package\//, ''))),
  };
}

async function verifyConsumer(
  artifact: PackedArtifact,
  artifactsByName: ReadonlyMap<string, PackedArtifact>,
  consumerRoot: string,
): Promise<void> {
  const isRoot = artifact.pkg.name === ROOT_PACKAGE;
  const extraNames = isRoot ? [NODE_RUNTIME_PACKAGE] : [];
  const workspaceNames = workspaceClosure(artifact.pkg.name, artifactsByName, extraNames);
  const dependencies: Record<string, string> = {
    ...requiredExternalPeers(workspaceNames, artifactsByName),
  };
  for (const workspaceName of workspaceNames) {
    dependencies[workspaceName] = `file:${artifactsByName.get(workspaceName)!.tarballPath}`;
  }

  const consumerDir = join(
    consumerRoot,
    artifact.pkg.name.replaceAll('@', '').replaceAll('/', '__'),
  );
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `verify-${basename(consumerDir)}`,
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    )}\n`,
  );

  const installConsumer = async (omitOptional: boolean) => {
    const command = [
      'npm',
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      `--registry=${NPM_REGISTRY}`,
    ];
    if (omitOptional) command.push('--omit=optional');
    const install = await runCommand(command, consumerDir);
    if (install.exitCode !== 0) {
      throw new Error(
        `[packed-artifacts] clean install failed for ${artifact.pkg.name}:\n${install.stderr || install.stdout}`,
      );
    }
  };
  await installConsumer(true);

  writeFileSync(join(consumerDir, 'import-one.mjs'), 'await import(process.argv[2]);\n');
  const importSpecifier = async (specifier: string) => {
    let imported = await runCommand(['node', 'import-one.mjs', specifier], consumerDir);
    if (imported.exitCode !== 0 && imported.stderr.includes("Received protocol 'bun:'")) {
      imported = await runCommand(['bun', 'import-one.mjs', specifier], consumerDir);
    }
    if (imported.exitCode !== 0) {
      throw new Error(
        `[packed-artifacts] public import smoke failed for ${specifier}:\n${imported.stderr || imported.stdout}`,
      );
    }
  };

  const imports = publicImportSpecifiers(artifact.manifest);
  const primaryImport = imports.find(specifier => specifier === artifact.pkg.name);
  if (primaryImport) {
    await importSpecifier(primaryImport);
  }

  if (isRoot) {
    const rootSmokeScript = [
      `const slingshot = await import('${ROOT_PACKAGE}');`,
      `const { nodeRuntime } = await import('${NODE_RUNTIME_PACKAGE}');`,
      'const config = slingshot.defineApp({',
      '  runtime: nodeRuntime(),',
      "  hostname: '127.0.0.1',",
      '  port: 0,',
      "  db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },",
      '});',
      'const server = await slingshot.createServer(config);',
      'await server.stop(true);',
    ];
    writeFileSync(join(consumerDir, 'root-smoke.mjs'), `${rootSmokeScript.join('\n')}\n`);
    const smoke = await runCommand(['node', 'root-smoke.mjs'], consumerDir);
    if (smoke.exitCode !== 0) {
      throw new Error(
        `[packed-artifacts] root boot smoke failed:\n${smoke.stderr || smoke.stdout}`,
      );
    }
  }

  const fullWorkspaceNames = workspaceClosure(artifact.pkg.name, artifactsByName, extraNames, true);
  const fullDependencies: Record<string, string> = {
    ...requiredExternalPeers(fullWorkspaceNames, artifactsByName, true),
  };
  for (const workspaceName of fullWorkspaceNames) {
    fullDependencies[workspaceName] = `file:${artifactsByName.get(workspaceName)!.tarballPath}`;
  }
  if (JSON.stringify(fullDependencies) !== JSON.stringify(dependencies)) {
    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: `verify-${basename(consumerDir)}`,
          private: true,
          type: 'module',
          dependencies: fullDependencies,
        },
        null,
        2,
      )}\n`,
    );
    await installConsumer(false);
  }

  for (const specifier of imports) {
    await importSpecifier(specifier);
  }
}

export async function verifyPackedArtifacts(rootDir = process.cwd()): Promise<void> {
  const stageRoot = join(rootDir, '.tmp', 'verify-packed-artifacts', 'stage');
  const consumerRoot = mkdtempSync(join(tmpdir(), 'slingshot-packed-consumers-'));
  const { packages, versionByPackageName } = collectPublishablePackages(rootDir, stageRoot);

  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });

  try {
    const stageErrors: string[] = [];
    for (const pkg of packages) {
      const warnings = stagePackage(pkg, {
        repoLicensePath: join(rootDir, 'LICENSE'),
        rootDir,
        targetRegistry: NPM_REGISTRY,
        versionByPackageName,
      });
      if (warnings.length > 0) {
        stageErrors.push(...warnings.map(warning => `${pkg.name}: ${warning}`));
      }
      const integrityErrors = findStageIntegrityErrors(pkg.stageDir, pkg.manifest, rootDir);
      stageErrors.push(...integrityErrors.map(error => `${pkg.name}: ${error}`));
    }
    if (stageErrors.length > 0) {
      throw new Error(
        `[packed-artifacts] staged-file checks failed:\n${stageErrors
          .map(error => `- ${error}`)
          .join('\n')}`,
      );
    }

    const artifacts = await Promise.all(packages.map(packStage));
    const artifactsByName = new Map(artifacts.map(artifact => [artifact.pkg.name, artifact]));
    const manifestErrors: string[] = [];
    for (const artifact of artifacts) {
      manifestErrors.push(
        ...findPackedManifestErrors(artifact.manifest, artifact.files).map(
          error => `${artifact.pkg.name}: ${error}`,
        ),
      );
      if (artifact.pkg.name === ROOT_PACKAGE) {
        manifestErrors.push(
          ...findRootPackedSurfaceErrors(artifact, rootDir).map(
            error => `${artifact.pkg.name}: ${error}`,
          ),
        );
      }
    }
    if (manifestErrors.length > 0) {
      throw new Error(
        `[packed-artifacts] tarball checks failed:\n${manifestErrors
          .map(error => `- ${error}`)
          .join('\n')}`,
      );
    }

    for (const [index, artifact] of artifacts.entries()) {
      console.log(
        `[packed-artifacts] (${index + 1}/${artifacts.length}) Installing and importing ${artifact.pkg.name}...`,
      );
      await verifyConsumer(artifact, artifactsByName, consumerRoot);
    }
    console.log(`[packed-artifacts] Verified ${artifacts.length} independently packed package(s).`);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await verifyPackedArtifacts();
}
