import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type BuildStep = {
  name: string;
  cwd?: string;
  cleanTargets?: CleanTarget[];
  commands: string[][];
};

type CleanTarget = {
  path: string;
  preserveEntries?: string[];
};

type WorkspacePackage = {
  name: string;
  dir: string;
  dependencies: string[];
  optionalDependencies: string[];
  peerDependencies: string[];
};

const packagesOnly = process.argv.includes('--packages-only');
const excludedPackages = new Set(['@lastshotlabs/slingshot-docs']);

const workspacePackages: WorkspacePackage[] = fs
  .readdirSync('packages', { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
    const dir = path.join('packages', entry.name);
    const manifestPath = path.join(dir, 'package.json');
    const buildConfigPath = path.join(dir, 'tsconfig.build.json');
    if (!fs.existsSync(manifestPath)) return [];
    if (!fs.existsSync(buildConfigPath)) return [];

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    if (excludedPackages.has(manifest.name ?? '')) return [];

    return [
      {
        name: manifest.name ?? entry.name,
        dir,
        dependencies: [...Object.keys(manifest.dependencies ?? {})],
        optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}),
        peerDependencies: Object.keys(manifest.peerDependencies ?? {}),
      },
    ];
  });

const workspacePackageNames = new Set(workspacePackages.map(pkg => pkg.name));
const packageLookup = new Map(workspacePackages.map(pkg => [pkg.name, pkg]));
const dependencyGraph = new Map<string, Set<string>>();
const reverseDependencyGraph = new Map<string, Set<string>>();

for (const pkg of workspacePackages) {
  const internalDeps = [
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  ].filter(dep => workspacePackageNames.has(dep) && dep !== pkg.name);
  dependencyGraph.set(pkg.name, new Set(internalDeps));
  for (const dep of internalDeps) {
    const dependents = reverseDependencyGraph.get(dep) ?? new Set<string>();
    dependents.add(pkg.name);
    reverseDependencyGraph.set(dep, dependents);
  }
}

const readyQueue = workspacePackages
  .filter(pkg => (dependencyGraph.get(pkg.name)?.size ?? 0) === 0)
  .map(pkg => pkg.name)
  .sort((a, b) => a.localeCompare(b));

const pendingDependencies = new Map(
  [...dependencyGraph.entries()].map(([name, deps]) => [name, new Set(deps)]),
);

const packageBuildLayers: string[][] = [];

while (readyQueue.length > 0) {
  const currentLayer = [...readyQueue];
  readyQueue.length = 0;
  packageBuildLayers.push(currentLayer);

  for (const next of currentLayer) {
    for (const dependent of reverseDependencyGraph.get(next) ?? []) {
      const deps = pendingDependencies.get(dependent);
      if (!deps) continue;
      deps.delete(next);
      if (deps.size === 0) {
        readyQueue.push(dependent);
      }
    }
    pendingDependencies.delete(next);
  }

  readyQueue.sort((a, b) => a.localeCompare(b));
}

if (pendingDependencies.size > 0) {
  const remaining = [...pendingDependencies.keys()].sort((a, b) => a.localeCompare(b));
  throw new Error(
    `[build] dependency cycle or unresolved hard workspace dependency detected: ${remaining.join(', ')}`,
  );
}

const maxParallelPackageBuilds = Math.max(
  2,
  Math.min(
    6,
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  ),
);

const createEmitCommand = (tsconfigPath: string): string[] => [
  'bun',
  'x',
  'tsc',
  '-p',
  tsconfigPath,
  '--noCheck',
];

const createAliasRewriteCommand = (tsconfigPath: string): string[] => [
  'bun',
  'x',
  'tsc-alias',
  '-p',
  tsconfigPath,
  '--resolve-full-paths',
  '--resolve-full-extension',
  '.js',
];

const packageStepsByLayer: BuildStep[][] = packageBuildLayers.map(layer =>
  layer.map(name => ({
    name: `${name} build output`,
    cleanTargets: [
      { path: path.join(packageLookup.get(name)!.dir, 'dist') },
      { path: path.join(packageLookup.get(name)!.dir, '.tmp', 'tsconfig.build.tsbuildinfo') },
    ],
    commands: [
      createEmitCommand(path.join(packageLookup.get(name)!.dir, 'tsconfig.build.json')),
      createAliasRewriteCommand(path.join(packageLookup.get(name)!.dir, 'tsconfig.build.json')),
    ],
  })),
);

const frameworkSteps: BuildStep[] = [
  {
    name: 'framework build output',
    cleanTargets: [
      { path: path.join('dist', 'src', 'framework') },
      { path: path.join('.tmp', 'tsconfig.framework.build.tsbuildinfo') },
    ],
    commands: [
      createEmitCommand('tsconfig.framework.build.json'),
      createAliasRewriteCommand('tsconfig.framework.build.json'),
    ],
  },
];

const rootSteps: BuildStep[] = [
  {
    name: 'root build output',
    cleanTargets: [
      {
        path: path.join('dist', 'src'),
        preserveEntries: ['framework'],
      },
      { path: path.join('.tmp', 'tsconfig.build.tsbuildinfo') },
    ],
    commands: [
      createEmitCommand('tsconfig.build.json'),
      createAliasRewriteCommand('tsconfig.build.json'),
    ],
  },
  { name: 'cli bundle', commands: [['bun', 'x', 'tsup', '--config', 'tsup.cli.config.ts']] },
  { name: 'oclif manifest', commands: [['bun', 'x', 'oclif', 'manifest', '.']] },
];

const steps = packagesOnly ? [] : [...frameworkSteps, ...rootSteps];

const formatSeconds = (startedAt: number): string =>
  `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

function rewriteFrameworkDeclarationImports(): void {
  const frameworkDistDir = path.join('dist', 'src', 'framework');
  if (!fs.existsSync(frameworkDistDir)) return;

  const queue = [frameworkDistDir];
  while (queue.length > 0) {
    const currentDir = queue.pop()!;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !fullPath.endsWith('.d.ts')) continue;

      const original = fs.readFileSync(fullPath, 'utf8');
      const rewritten = original
        .replace(/(['"])(?:\.\.\/)+config\/([^'"]+)\1/g, '$1@config/$2$1')
        .replace(/(['"])(?:\.\.\/)+lib\/([^'"]+)\1/g, '$1@lib/$2$1');

      if (rewritten !== original) {
        fs.writeFileSync(fullPath, rewritten);
      }
    }
  }
}

function cleanTarget(target: CleanTarget): void {
  if (!fs.existsSync(target.path)) return;

  const preserveEntries = new Set(target.preserveEntries ?? []);
  const stats = fs.statSync(target.path);

  if (!stats.isDirectory() || preserveEntries.size === 0) {
    fs.rmSync(target.path, { recursive: true, force: true });
    return;
  }

  for (const entry of fs.readdirSync(target.path, { withFileTypes: true })) {
    if (preserveEntries.has(entry.name)) continue;
    fs.rmSync(path.join(target.path, entry.name), { recursive: true, force: true });
  }
}

async function runStep(step: BuildStep): Promise<void> {
  const startedAt = Date.now();
  console.log(`[build] ${step.name}...`);
  const heartbeat = setInterval(() => {
    console.log(`[build] ${step.name} still running after ${formatSeconds(startedAt)}...`);
  }, 10_000);

  try {
    for (const cleanTargetEntry of step.cleanTargets ?? []) {
      cleanTarget(cleanTargetEntry);
    }

    for (const command of step.commands) {
      const proc = Bun.spawn({
        cmd: command,
        cwd: step.cwd,
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        console.error(
          `[build] ${step.name} failed after ${formatSeconds(startedAt)} (exit ${exitCode})`,
        );
        process.exit(exitCode);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  console.log(`[build] ${step.name} done in ${formatSeconds(startedAt)}`);
}

async function runPackageLayer(layerIndex: number, stepsInLayer: BuildStep[]): Promise<void> {
  const queue = [...stepsInLayer];
  const running = new Set<Promise<void>>();
  console.log(
    `[build] workspace package layer ${layerIndex + 1}/${packageStepsByLayer.length}: ${stepsInLayer.length} package(s)`,
  );

  while (queue.length > 0 || running.size > 0) {
    while (queue.length > 0 && running.size < maxParallelPackageBuilds) {
      const step = queue.shift()!;
      const task = runStep(step).finally(() => {
        running.delete(task);
      });
      running.add(task);
    }

    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

for (let index = 0; index < packageStepsByLayer.length; index += 1) {
  await runPackageLayer(index, packageStepsByLayer[index]!);
}

// Sync README.md from docs/human/index.md for each workspace package
for (const entry of fs.readdirSync('packages', { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'docs') continue;
  const humanDoc = path.join('packages', entry.name, 'docs', 'human', 'index.md');
  const readme = path.join('packages', entry.name, 'README.md');
  if (fs.existsSync(humanDoc)) {
    fs.copyFileSync(humanDoc, readme);
  }
}

for (const step of steps) {
  await runStep(step);
  if (step.name === 'root build output') {
    console.log('[build] framework declaration import rewrite...');
    rewriteFrameworkDeclarationImports();
    console.log('[build] framework declaration import rewrite done');
  }
}
