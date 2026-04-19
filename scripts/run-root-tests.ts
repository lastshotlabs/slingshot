import { collectRootTestFiles, partitionRootTestFiles } from './root-test-files';

async function runFiles(label: string, files: string[]): Promise<void> {
  console.log(`test:root -> ${label}`);
  const proc = Bun.spawn(['bun', 'test', ...files], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.exit(code);
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
    await runFiles(`bulk ${index / chunkSize + 1}`, chunk);
  }
}

for (const file of isolated) {
  await runFiles(`isolated ${file}`, [file]);
}

process.exit(0);
