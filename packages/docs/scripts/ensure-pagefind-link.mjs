import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function getPagefindPaths(repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')) {
  const rootNodeModules = resolve(repoRoot, 'node_modules');
  return {
    bunHoistedTarget: resolve(rootNodeModules, '.bun', 'node_modules', 'pagefind'),
    expectedLink: resolve(rootNodeModules, 'pagefind'),
    rootNodeModules,
  };
}

function ensurePagefindLink(paths = getPagefindPaths(), io = console) {
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

    rmSync(paths.expectedLink, { force: true, recursive: true });
  }

  mkdirSync(paths.rootNodeModules, { recursive: true });
  symlinkSync(paths.bunHoistedTarget, paths.expectedLink, 'junction');
  io.log(`[ensure-pagefind-link] Linked ${paths.expectedLink} -> ${paths.bunHoistedTarget}`);
}

ensurePagefindLink();
