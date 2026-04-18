import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve a stable repo identity string for cross-repo registry coordination.
 *
 * The identity is used as the `repo` field on every `RegistryServiceEntry`
 * written by the deploy pipeline. It must be stable across deploys so that
 * multi-repo registry documents can correctly attribute services to their
 * source repositories.
 *
 * Resolution order (first match wins):
 * 1. `name` field from `<appRoot>/package.json` — npm scopes are stripped,
 *    so `"@org/my-app"` resolves to `"my-app"`.
 * 2. Basename of the `git remote get-url origin` URL with `.git` stripped
 *    (e.g. `"git@github.com:acme/api.git"` → `"api"`).
 *
 * @param appRoot - Absolute path to the application root directory. Used to
 *   locate `package.json` and as the `cwd` for the `git` subprocess.
 * @returns A non-empty string suitable for use as a registry repo identifier.
 *
 * @throws {Error} If neither `package.json` nor a git remote origin is
 *   available. The error message advises setting `repo` in `slingshot.infra.ts`.
 *
 * @example
 * ```ts
 * import { resolveRepoIdentity } from '@lastshotlabs/slingshot-infra';
 *
 * // In a repo with package.json name "@acme/api":
 * resolveRepoIdentity('/home/user/projects/api'); // → 'api'
 *
 * // In a repo without package.json, with git origin "git@github.com:acme/api.git":
 * resolveRepoIdentity('/home/user/projects/api'); // → 'api'
 * ```
 */
export function resolveRepoIdentity(appRoot: string): string {
  const pkgPath = join(appRoot, 'package.json');
  if (existsSync(pkgPath)) {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as unknown;
    if (pkg && typeof pkg === 'object' && 'name' in pkg) {
      const name = (pkg as Record<string, unknown>).name;
      if (typeof name === 'string' && name.length > 0) {
        return name.replace(/^@[^/]+\//, '');
      }
    }
  }

  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: appRoot,
    encoding: 'utf-8',
  });
  if (result.status === 0 && result.stdout.trim()) {
    const url = result.stdout.trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }

  throw new Error(
    'Cannot determine repo identity. Set "repo" in slingshot.infra.ts or ensure package.json has a "name" field.',
  );
}
