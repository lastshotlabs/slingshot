import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CodeAppCheck,
  type ExampleCheckDefinition,
  type ModuleExportsCheck,
  exampleRegistry,
} from '../examples/registry.ts';
import { createApp } from '../src/index.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function importModule(
  entrypoint: string,
  root = repoRoot,
): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(resolve(root, entrypoint)).href;
  return (await import(moduleUrl)) as Record<string, unknown>;
}

// Server-only keys that `defineApp()` accepts but `createApp()` does not — strip
// them before calling createApp so the smoke check doesn't trigger spurious
// "unknown config key" warnings.
const SERVER_ONLY_KEYS = new Set([
  'port',
  'hostname',
  'unix',
  'tls',
  'workersDir',
  'enableWorkers',
  'sse',
  'maxRequestBodySize',
]);

function stripServerOnlyKeys(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (!SERVER_ONLY_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function loadConfigFromModule(mod: Record<string, unknown>): Record<string, unknown> | null {
  const defaultExport = mod.default;
  if (defaultExport && typeof defaultExport === 'object') {
    return defaultExport as Record<string, unknown>;
  }
  return null;
}

function hasStaticExport(source: string, exportName: string): boolean {
  if (exportName === 'default') {
    return /\bexport\s+default\b/.test(source);
  }

  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+${escaped}\\b`,
  );
  const namedList = new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  return declaration.test(source) || namedList.test(source);
}

export async function smokeCodeExample(
  example: CodeAppCheck,
  options: {
    createAppFn?: typeof createApp;
    importModuleFn?: typeof importModule;
    root?: string;
  } = {},
): Promise<void> {
  const importModuleFn = options.importModuleFn ?? importModule;
  const createAppFn = options.createAppFn ?? createApp;
  const mod = await importModuleFn(example.entrypoint, options.root);
  const config = loadConfigFromModule(mod);

  if (!config) {
    throw new Error(`${example.entrypoint} must export a defineApp() default`);
  }

  const appConfig = stripServerOnlyKeys(config);
  const result = await createAppFn(appConfig as Parameters<typeof createApp>[0]);

  if (!result.app || !result.ctx) {
    throw new Error(`${example.name} did not return a Slingshot app and context`);
  }

  await result.ctx.destroy();
}

export async function smokeModuleExportsExample(
  example: ModuleExportsCheck,
  options: {
    importModuleFn?: typeof importModule;
    root?: string;
  } = {},
): Promise<void> {
  const importModuleFn = options.importModuleFn ?? importModule;

  if (!example.requiredPlugins?.length) {
    const root = options.root ?? repoRoot;
    const source = readFileSync(resolve(root, example.entrypoint), 'utf8');
    for (const exportName of example.exports) {
      if (!hasStaticExport(source, exportName)) {
        throw new Error(`${example.entrypoint} is missing export "${exportName}"`);
      }
    }
    return;
  }

  const mod = await importModuleFn(example.entrypoint, options.root);
  for (const exportName of example.exports) {
    if (!(exportName in mod)) {
      throw new Error(`${example.entrypoint} is missing export "${exportName}"`);
    }
  }

  const config = loadConfigFromModule(mod) as { plugins?: Array<{ name?: string }> } | null;

  if (!config) {
    throw new Error(`${example.entrypoint} must export a defineApp() default to validate plugins`);
  }

  const pluginNames = new Set((config.plugins ?? []).map(plugin => plugin.name).filter(Boolean));

  for (const requiredPlugin of example.requiredPlugins) {
    if (!pluginNames.has(requiredPlugin)) {
      throw new Error(`${example.entrypoint} is missing required plugin "${requiredPlugin}"`);
    }
  }
}

export async function runCheck(
  _exampleName: string,
  check: ExampleCheckDefinition,
  options: {
    createAppFn?: typeof createApp;
    importModuleFn?: typeof importModule;
    root?: string;
  } = {},
): Promise<void> {
  if (check.kind === 'code-app') {
    await smokeCodeExample(check, options);
    return;
  }

  await smokeModuleExportsExample(check, options);
}

export async function runExamplesSmoke(
  registry = exampleRegistry,
  io: Pick<typeof console, 'error' | 'log'> = console,
  options: {
    createAppFn?: typeof createApp;
    importModuleFn?: typeof importModule;
    root?: string;
    stdout?: Pick<NodeJS.WriteStream, 'write'>;
  } = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  for (const example of registry) {
    for (const check of example.checks) {
      stdout.write(`examples:smoke ${example.name}:${check.kind} ... `);
      await runCheck(example.name, check, options);
      io.log('ok');
    }
  }
}

if (import.meta.main) {
  try {
    await runExamplesSmoke();
  } catch (error) {
    console.error('examples:smoke failed');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
