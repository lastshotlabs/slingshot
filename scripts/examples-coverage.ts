import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleRegistry } from '../examples/registry.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const examplesRoot = resolve(repoRoot, 'examples');

export function getExampleDirectories(root = examplesRoot): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `examples/${entry.name}`)
    .sort();
}

export interface ExamplesCoverageResult {
  discovered: string[];
  missingDocs: string[];
  missingFromRegistry: string[];
}

export function auditExamplesCoverage(
  registry = exampleRegistry,
  root = repoRoot,
  rootExamples = examplesRoot,
): ExamplesCoverageResult {
  const registered = new Set(registry.map(example => example.directory));
  const discovered = getExampleDirectories(rootExamples);

  const missingFromRegistry = discovered.filter(directory => !registered.has(directory));
  const missingDocs = registry
    .filter(example => !existsSync(resolve(root, example.docsPath)))
    .map(example => `${example.name}: ${example.docsPath}`);

  return { discovered, missingDocs, missingFromRegistry };
}

export function main(
  registry = exampleRegistry,
  io: Pick<typeof console, 'error' | 'log'> = console,
  root = repoRoot,
  rootExamples = examplesRoot,
): number {
  const { missingDocs, missingFromRegistry } = auditExamplesCoverage(registry, root, rootExamples);

  if (missingFromRegistry.length === 0 && missingDocs.length === 0) {
    io.log(`examples:coverage - ${registry.length} example(s) registered, 0 gaps.`);
    return 0;
  }

  io.error('examples:coverage failed');
  if (missingFromRegistry.length > 0) {
    io.error(`Unregistered example directories: ${missingFromRegistry.join(', ')}`);
  }
  if (missingDocs.length > 0) {
    io.error(`Missing docs pages: ${missingDocs.join(', ')}`);
  }

  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
