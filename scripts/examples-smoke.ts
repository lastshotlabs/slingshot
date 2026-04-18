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

async function importModule(entrypoint: string): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(resolve(repoRoot, entrypoint)).href;
  return (await import(moduleUrl)) as Record<string, unknown>;
}

async function smokeCodeExample(example: CodeAppCheck): Promise<void> {
  const moduleUrl = pathToFileURL(resolve(repoRoot, example.entrypoint)).href;
  const mod = (await import(moduleUrl)) as { buildAppConfig?: () => unknown };

  if (typeof mod.buildAppConfig !== 'function') {
    throw new Error(`${example.entrypoint} must export buildAppConfig()`);
  }

  const config = mod.buildAppConfig();
  const result = await createApp(config as Parameters<typeof createApp>[0]);

  if (!result.app || !result.ctx) {
    throw new Error(`${example.name} did not return a Slingshot app and context`);
  }

  await result.ctx.destroy();
}

async function smokeManifestExample(example: ManifestCheck): Promise<void> {
  const manifestFile = Bun.file(resolve(repoRoot, example.manifestPath));
  const raw = await manifestFile.json();
  const result = validateAppManifest(raw);

  if (!result.success) {
    throw new Error(result.errors.join('\n'));
  }

  if (example.handlerModule && example.handlerExports?.length) {
    const moduleUrl = pathToFileURL(resolve(repoRoot, example.handlerModule)).href;
    const mod = (await import(moduleUrl)) as Record<string, unknown>;

    for (const exportName of example.handlerExports) {
      if (!(exportName in mod)) {
        throw new Error(`${example.handlerModule} is missing export "${exportName}"`);
      }
    }
  }
}

async function smokeModuleExportsExample(example: ModuleExportsCheck): Promise<void> {
  const mod = await importModule(example.entrypoint);

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

async function runCheck(exampleName: string, check: ExampleCheckDefinition): Promise<void> {
  if (check.kind === 'code-app') {
    await smokeCodeExample(check);
    return;
  }

  if (check.kind === 'manifest') {
    await smokeManifestExample(check);
    return;
  }

  await smokeModuleExportsExample(check);
}

async function run(): Promise<void> {
  for (const example of exampleRegistry) {
    for (const check of example.checks) {
      process.stdout.write(`examples:smoke ${example.name}:${check.kind} ... `);
      await runCheck(example.name, check);
      console.log('ok');
    }
  }
}

try {
  await run();
} catch (error) {
  console.error('examples:smoke failed');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
