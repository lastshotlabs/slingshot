import { readFileSync } from 'node:fs';

const patterns = [
  'tests/unit/**/*.test.ts',
  'tests/unit/**/*.test.tsx',
  'tests/integration/**/*.test.ts',
  'tests/integration/**/*.test.tsx',
] as const;

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

export function fileRequiresIsolatedProcess(path: string): boolean {
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
