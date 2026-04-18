#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const rootNodeModules = resolve(repoRoot, 'node_modules');
const expectedLink = resolve(rootNodeModules, 'pagefind');
const bunHoistedTarget = resolve(rootNodeModules, '.bun', 'node_modules', 'pagefind');

function ensurePagefindLink(): void {
  if (!existsSync(bunHoistedTarget)) {
    console.warn(`[ensure-pagefind-link] Skipping: target not found at ${bunHoistedTarget}`);
    return;
  }

  if (existsSync(expectedLink)) {
    try {
      const stat = lstatSync(expectedLink);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        return;
      }
    } catch {
      // Fall through and recreate if the path is unreadable.
    }

    rmSync(expectedLink, { recursive: true, force: true });
  }

  mkdirSync(rootNodeModules, { recursive: true });
  symlinkSync(bunHoistedTarget, expectedLink, 'junction');
  console.log(`[ensure-pagefind-link] Linked ${expectedLink} -> ${bunHoistedTarget}`);
}

ensurePagefindLink();
