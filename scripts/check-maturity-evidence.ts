#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateMaturityOutputs, repoRoot } from './generate-maturity-evidence';

try {
  for (const [path, expected] of Object.entries(await generateMaturityOutputs(repoRoot))) {
    const absolute = resolve(repoRoot, path);
    if (!existsSync(absolute) || readFileSync(absolute, 'utf8') !== expected) {
      throw new Error(`[maturity] Generated output is stale or manually edited: ${path}`);
    }
  }
  console.log('[maturity] Declaration, evidence, release, docs, and runtime metadata agree.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
