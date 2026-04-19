import { collectRootTestFiles, partitionRootTestFiles } from './root-test-files';

export async function runFiles(
  label: string,
  files: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  console.log(`test:root -> ${label}`);
  const proc = spawnFn(['bun', 'test', ...files], {
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

export async function runRootTests(
  files?: string[],
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<number> {
  const resolvedFiles = files ?? (await collectRootTestFiles());
  if (resolvedFiles.length === 0) {
    return 0;
  }

  const chunkSize = 40;
  const { bulk, isolated } = partitionRootTestFiles(resolvedFiles);

  for (let index = 0; index < bulk.length; index += chunkSize) {
    const chunk = bulk.slice(index, index + chunkSize);
    if (chunk.length > 0) {
      const code = await runFiles(`bulk ${index / chunkSize + 1}`, chunk, spawnFn);
      if (code !== 0) {
        return code;
      }
    }
  }

  for (const file of isolated) {
    const code = await runFiles(`isolated ${file}`, [file], spawnFn);
    if (code !== 0) {
      return code;
    }
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await runRootTests());
}
