#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PagefindPaths {
  bunHoistedTarget: string;
  expectedLink: string;
  rootNodeModules: string;
}

export function getPagefindPaths(repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')): PagefindPaths {
  const rootNodeModules = resolve(repoRoot, 'node_modules');
  return {
    rootNodeModules,
    expectedLink: resolve(rootNodeModules, 'pagefind'),
    bunHoistedTarget: resolve(rootNodeModules, '.bun', 'node_modules', 'pagefind'),
  };
}

export function ensurePagefindLink(
  paths: PagefindPaths = getPagefindPaths(),
  io: Pick<typeof console, 'log' | 'warn'> = console,
): void {
  if (!existsSync(paths.bunHoistedTarget)) {
    io.warn(`[ensure-pagefind-link] Skipping: target not found at ${paths.bunHoistedTarget}`);
    return;
  }

  if (existsSync(paths.expectedLink)) {
    try {
      const stat = lstatSync(paths.expectedLink);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        return;
      }
    } catch {
      // Fall through and recreate if the path is unreadable.
    }

    rmSync(paths.expectedLink, { recursive: true, force: true });
  }

  mkdirSync(paths.rootNodeModules, { recursive: true });
  symlinkSync(paths.bunHoistedTarget, paths.expectedLink, 'junction');
  io.log(`[ensure-pagefind-link] Linked ${paths.expectedLink} -> ${paths.bunHoistedTarget}`);
}

if (import.meta.main) {
  ensurePagefindLink();
}
