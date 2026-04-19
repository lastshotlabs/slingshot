import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CodeAppCheck,
  type ExampleCheckDefinition,
  type ManifestCheck,
  type ModuleExportsCheck,
  exampleRegistry,
} from '../examples/registry.ts';
import { createApp, validateAppManifest } from '../src/index.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function importModule(
  entrypoint: string,
  root = repoRoot,
): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(resolve(root, entrypoint)).href;
  return (await import(moduleUrl)) as Record<string, unknown>;
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
  const mod = (await importModuleFn(example.entrypoint, options.root)) as {
    buildAppConfig?: () => unknown;
  };

  if (typeof mod.buildAppConfig !== 'function') {
    throw new Error(`${example.entrypoint} must export buildAppConfig()`);
  }

  const config = mod.buildAppConfig();
  const result = await createAppFn(config as Parameters<typeof createApp>[0]);

  if (!result.app || !result.ctx) {
    throw new Error(`${example.name} did not return a Slingshot app and context`);
  }

  await result.ctx.destroy();
}

export async function smokeManifestExample(
  example: ManifestCheck,
  options: {
    importModuleFn?: typeof importModule;
    root?: string;
    validateAppManifestFn?: typeof validateAppManifest;
  } = {},
): Promise<void> {
  const root = options.root ?? repoRoot;
  const validateAppManifestFn = options.validateAppManifestFn ?? validateAppManifest;
  const manifestFile = Bun.file(resolve(root, example.manifestPath));
  const raw = await manifestFile.json();
  const result = validateAppManifestFn(raw);

  if (!result.success) {
    throw new Error(result.errors.join('\n'));
  }

  if (example.handlerModule && example.handlerExports?.length) {
    const importModuleFn = options.importModuleFn ?? importModule;
    const mod = await importModuleFn(example.handlerModule, root);

    for (const exportName of example.handlerExports) {
      if (!(exportName in mod)) {
        throw new Error(`${example.handlerModule} is missing export "${exportName}"`);
      }
    }
  }
}

export async function smokeModuleExportsExample(
  example: ModuleExportsCheck,
  options: {
    importModuleFn?: typeof importModule;
    root?: string;
  } = {},
): Promise<void> {
  const importModuleFn = options.importModuleFn ?? importModule;
  const mod = await importModuleFn(example.entrypoint, options.root);

  for (const exportName of example.exports) {
    if (!(exportName in mod)) {
      throw new Error(`${example.entrypoint} is missing export "${exportName}"`);
    }
  }

  if (!example.requiredPlugins?.length) {
    return;
  }

  const buildAppConfig = mod.buildAppConfig;
  if (typeof buildAppConfig !== 'function') {
    throw new Error(`${example.entrypoint} must export buildAppConfig() to validate plugins`);
  }

  const config = buildAppConfig() as { plugins?: Array<{ name?: string }> };
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
    validateAppManifestFn?: typeof validateAppManifest;
  } = {},
): Promise<void> {
  if (check.kind === 'code-app') {
    await smokeCodeExample(check, options);
    return;
  }

  if (check.kind === 'manifest') {
    await smokeManifestExample(check, options);
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
    validateAppManifestFn?: typeof validateAppManifest;
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
