import { readFileSync } from 'node:fs';

const patterns = [
  'tests/unit/**/*.test.ts',
  'tests/unit/**/*.test.tsx',
  'tests/integration/**/*.test.ts',
  'tests/integration/**/*.test.tsx',
] as const;

export const rootCoverageSupplementalFiles = [
  'tests/isolated/jobs-router.test.ts',
  'tests/isolated/optional-deps.test.ts',
  'tests/isolated/queue.test.ts',
  'tests/isolated/queued-deletion.test.ts',
  'tests/isolated/zodToMongoose.test.ts',
] as const;

const processIsolatedFiles = new Set([
  'tests/unit/auditLogProviders.test.ts',
  'tests/unit/cronRegistry.test.ts',
  'tests/unit/uploadRegistry-backends.test.ts',
  'tests/unit/uploadRegistryBackends.test.ts',
]);

async function collectFiles(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
    files.push(file);
  }
  return files;
}

export async function collectRootTestFiles(): Promise<string[]> {
  return (await Promise.all(patterns.map(collectFiles)))
    .flat()
    .sort((a, b) => a.localeCompare(b));
}

export async function collectRootCoverageTestFiles(): Promise<string[]> {
  return Array.from(new Set([...(await collectRootTestFiles()), ...rootCoverageSupplementalFiles]))
    .sort((a, b) => a.localeCompare(b));
}

export function fileRequiresIsolatedProcess(path: string): boolean {
  if (processIsolatedFiles.has(path.replace(/\\/g, '/'))) {
    return true;
  }
  const source = readFileSync(path, 'utf8');
  return /\bmock\.module\s*\(/.test(source);
}

export function partitionRootTestFiles(files: string[]): {
  bulk: string[];
  isolated: string[];
} {
  const bulk: string[] = [];
  const isolated: string[] = [];

  for (const file of files) {
    if (fileRequiresIsolatedProcess(file)) {
      isolated.push(file);
    } else {
      bulk.push(file);
    }
  }

  return { bulk, isolated };
}
