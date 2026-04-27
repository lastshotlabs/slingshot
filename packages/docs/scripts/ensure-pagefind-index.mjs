import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const distDir = resolve(repoRoot, 'packages/docs/dist');
const pagefindDir = resolve(distDir, 'pagefind');

if (existsSync(pagefindDir)) {
  process.exit(0);
}

const bunStore = resolve(repoRoot, 'node_modules/.bun');

async function findPagefindExe(dir) {
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const targets = ['pagefind', 'pagefind_extended'];
  for (const entry of entries) {
    if (entry.isFile() && targets.includes(entry.name)) {
      return resolve(entry.parentPath, entry.name);
    }
  }
  return null;
}

const exe = await findPagefindExe(bunStore);
if (!exe) {
  console.error(`[ensure-pagefind-index] Unable to find pagefind executable under ${bunStore}`);
  process.exit(1);
}

const result = spawnSync(exe, ['--site', distDir], { stdio: 'inherit' });
process.exit(result.status ?? 0);
