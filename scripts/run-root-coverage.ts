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

const files = (await Promise.all(patterns.map(collectFiles)))
  .flat()
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  process.exit(0);
}

const proc = Bun.spawn(
  [
    process.execPath,
    'test',
    '--coverage',
    '--coverage-reporter',
    'text',
    '--coverage-reporter',
    'lcov',
    '--coverage-dir',
    'coverage/root',
    '--config',
    'bunfig.ci.toml',
    ...files,
  ],
  {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

process.exit(await proc.exited);
