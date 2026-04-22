import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type {
  AnyResolvedWorkflow,
} from '@lastshotlabs/slingshot-orchestration';
import type {
  OrchestrationProviderRegistry,
  ProviderTaskManifest,
} from '@lastshotlabs/slingshot-orchestration/provider';

function toImportPath(fromDir: string, targetPath: string): string {
  const rel = relative(fromDir, targetPath).replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function taskManifestLiteral(task: ProviderTaskManifest): string {
  return `{
    name: ${literal(task.name)},
    retry: ${literal(task.retry)},
    timeout: ${literal(task.timeout)},
    queue: ${literal(task.queue)},
    concurrency: ${literal(task.concurrency)}
  }`;
}

export async function generateTemporalWorkflowModule(options: {
  generatedWorkflowsDir: string;
  definitionsModulePath: string;
  workflows: readonly AnyResolvedWorkflow[];
  registry: OrchestrationProviderRegistry;
  packageWorkflowsPath: string;
}): Promise<string> {
  const outDir = resolve(options.generatedWorkflowsDir);
  await mkdir(outDir, { recursive: true });

  const modulePath = resolve(outDir, `slingshot-temporal-workflows-${Date.now()}.ts`);
  const importDefinitionsPath = toImportPath(dirname(modulePath), options.definitionsModulePath);
  const importPackageWorkflowsPath = toImportPath(dirname(modulePath), options.packageWorkflowsPath);
  const taskManifestEntries = options.registry
    .listTaskManifests()
    .map(task => `${literal(task.name)}: ${taskManifestLiteral(task)}`)
    .join(',\n  ');

  const manifestEntries = options.workflows
    .map(workflow => {
      const manifest = options.registry.getWorkflowManifest(workflow.name);
      const taskEntries = Object.entries(manifest.tasks)
        .map(([taskName, task]) => `${literal(taskName)}: ${taskManifestLiteral(task)}`)
        .join(',\n        ');

      return `${literal(workflow.name)}: {
      workflow: requireWorkflow(${literal(workflow.name)}),
      tasks: {
        ${taskEntries}
      },
      hooks: ${literal(manifest.hooks)}
    }`;
    })
    .join(',\n  ');

  const source = `import { slingshotTaskWorkflowImpl, slingshotWorkflowImpl } from ${literal(
    importPackageWorkflowsPath,
  )};
import * as definitions from ${literal(importDefinitionsPath)};

function isResolvedTask(value) {
  return typeof value === 'object' && value !== null && value._tag === 'ResolvedTask';
}

function isResolvedWorkflow(value) {
  return typeof value === 'object' && value !== null && value._tag === 'ResolvedWorkflow';
}

function registerUnique(bucket, value, kind) {
  if (bucket.has(value.name)) {
    throw new Error(\`Duplicate Temporal \${kind} definition '\${value.name}' in definitions module.\`);
  }
  bucket.set(value.name, value);
}

function collectDefinitions() {
  const tasks = new Map();
  const workflows = new Map();

  for (const [exportName, value] of Object.entries(definitions)) {
    if (isResolvedTask(value)) {
      registerUnique(tasks, value, 'task');
      continue;
    }
    if (isResolvedWorkflow(value)) {
      registerUnique(workflows, value, 'workflow');
      continue;
    }
    if (exportName === 'tasks' && value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        if (isResolvedTask(item)) {
          registerUnique(tasks, item, 'task');
        }
      }
      continue;
    }
    if (exportName === 'workflows' && value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        if (isResolvedWorkflow(item)) {
          registerUnique(workflows, item, 'workflow');
        }
      }
    }
  }

  return { tasks, workflows };
}

const discovered = collectDefinitions();

function requireWorkflow(name) {
  const workflow = discovered.workflows.get(name);
  if (!workflow) {
    throw new Error(\`Workflow '\${name}' is not exported by the Temporal definitions module.\`);
  }
  return workflow;
}

const taskManifestMap = {
  ${taskManifestEntries}
};
const workflowManifestMap = {
  ${manifestEntries}
};

export async function slingshotTaskWorkflow(args) {
  return slingshotTaskWorkflowImpl(taskManifestMap, args);
}

export async function slingshotWorkflow(args) {
  return slingshotWorkflowImpl(workflowManifestMap, args);
}
`;

  await writeFile(modulePath, source, 'utf8');
  return modulePath;
}

/**
 * Generate a temporary definitions module that re-exports a set of handlers files so the
 * Temporal worker can import them through a single module path.
 */
export async function generateDirectoryDefinitionsModule(options: {
  outDir: string;
  files: readonly string[];
}): Promise<string> {
  await mkdir(options.outDir, { recursive: true });
  const modulePath = resolve(options.outDir, `manifest-definitions-${Date.now()}.ts`);
  const fileImports = [...options.files]
    .sort((left: string, right: string) => left.localeCompare(right))
    .map((filePath, index) => {
      const specifier = toImportPath(dirname(modulePath), filePath);
      const alias = `module${index}`;
      return `export * from ${literal(specifier)};\nimport * as ${alias} from ${literal(specifier)};`;
    })
    .join('\n');

  await writeFile(modulePath, `${fileImports}\n`, 'utf8');
  return modulePath;
}

/**
 * Resolve the bundled Temporal workflow implementation module shipped by this package.
 */
export function resolvePackageWorkflowsPath(): string {
  return resolve(import.meta.dirname, 'workflows.ts');
}
