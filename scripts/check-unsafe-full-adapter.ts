#!/usr/bin/env bun
/**
 * Reports `unsafeFullAdapter()` usage across the workspace. Run periodically as a soft
 * tracker for contract escape-hatch adoption — full CRUD exposure should feel exceptional,
 * so any growth here is a signal that contracts may be too narrow or that consumers are
 * skipping the contract narrowing they should be doing.
 *
 * Usage: `bun run scripts/check-unsafe-full-adapter.ts [--max=N]`
 *   --max=N    exit non-zero when occurrences exceed N (for CI ratchet)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.astro']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const TARGET = /\.unsafeFullAdapter\s*\(/;

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot !== -1 && SOURCE_EXTS.has(name.slice(dot))) yield full;
    }
  }
}

function isCallSite(file: string, text: string): boolean {
  if (file.endsWith('packageAuthoring.ts')) return false;
  if (file.endsWith('package-authoring.test.ts')) return false;
  if (file.endsWith('contracts.mdx')) return false;
  if (text.trim().startsWith('*') || text.trim().startsWith('//')) return false;
  return true;
}

function scanFile(file: string): Hit[] {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!TARGET.test(content)) return [];
  const hits: Hit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (TARGET.test(lines[i]) && isCallSite(file, lines[i])) {
      hits.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

function main(): number {
  const maxArg = process.argv.find(a => a.startsWith('--max='));
  const max = maxArg ? Number(maxArg.slice('--max='.length)) : Number.POSITIVE_INFINITY;

  const hits: Hit[] = [];
  for (const dirName of SCAN_DIRS) {
    const dir = join(ROOT, dirName);
    for (const file of walk(dir)) {
      hits.push(...scanFile(file));
    }
  }

  if (hits.length === 0) {
    console.log('unsafeFullAdapter usage: 0');
    return 0;
  }

  console.log(`unsafeFullAdapter usage: ${hits.length}`);
  for (const hit of hits) {
    const rel = hit.file.startsWith(ROOT) ? hit.file.slice(ROOT.length + 1) : hit.file;
    console.log(`  ${rel}:${hit.line}  ${hit.text}`);
  }

  if (Number.isFinite(max) && hits.length > max) {
    console.error(`\nExceeded max=${max} occurrences (${hits.length}). Failing.`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

export { main as checkUnsafeFullAdapter };
