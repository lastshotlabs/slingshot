import { posix, win32 } from 'node:path';

function usesWindowsPathSyntax(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * Resolve manifest paths in a platform-aware way.
 *
 * The manifest files are often tested with Windows-style base directories even
 * on non-Windows runners. Using the host path implementation directly would
 * treat `C:\...` as a relative path on POSIX, so we switch to `path.win32`
 * whenever either side uses Windows syntax.
 */
export function resolveManifestPath(value: string, baseDir: string): string {
  const substituted = value.replace('${importMetaDir}', baseDir);
  const pathApi =
    usesWindowsPathSyntax(baseDir) || usesWindowsPathSyntax(substituted) ? win32 : posix;
  return pathApi.resolve(baseDir, substituted);
}
