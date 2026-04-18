import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleRegistry } from '../examples/registry.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const examplesRoot = resolve(repoRoot, 'examples');

function getExampleDirectories(): string[] {
  return readdirSync(examplesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `examples/${entry.name}`)
    .sort();
}

function main(): number {
  const registered = new Set(exampleRegistry.map(example => example.directory));
  const discovered = getExampleDirectories();

  const missingFromRegistry = discovered.filter(directory => !registered.has(directory));
  const missingDocs = exampleRegistry
    .filter(example => !existsSync(resolve(repoRoot, example.docsPath)))
    .map(example => `${example.name}: ${example.docsPath}`);

  if (missingFromRegistry.length === 0 && missingDocs.length === 0) {
    console.log(`examples:coverage - ${exampleRegistry.length} example(s) registered, 0 gaps.`);
    return 0;
  }

  console.error('examples:coverage failed');
  if (missingFromRegistry.length > 0) {
    console.error(`Unregistered example directories: ${missingFromRegistry.join(', ')}`);
  }
  if (missingDocs.length > 0) {
    console.error(`Missing docs pages: ${missingDocs.join(', ')}`);
  }

  return 1;
}

process.exit(main());
