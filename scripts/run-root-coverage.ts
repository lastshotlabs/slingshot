import { collectRootTestFiles, partitionRootTestFiles } from './root-test-files';

async function runCoverage(label: string, files: string[]): Promise<void> {
  console.log(`test:coverage:root -> ${label}`);
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

  process.exitCode = await proc.exited;
  if (process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

const files = await collectRootTestFiles();

if (files.length === 0) {
  process.exit(0);
}

const chunkSize = 40;
const { bulk, isolated } = partitionRootTestFiles(files);

for (let index = 0; index < bulk.length; index += chunkSize) {
  const chunk = bulk.slice(index, index + chunkSize);
  if (chunk.length > 0) {
    await runCoverage(`bulk ${index / chunkSize + 1}`, chunk);
  }
}

for (const file of isolated) {
  await runCoverage(`isolated ${file}`, [file]);
}

process.exit(0);
