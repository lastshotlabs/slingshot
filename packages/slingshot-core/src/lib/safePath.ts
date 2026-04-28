// packages/slingshot-core/src/lib/safePath.ts
import path from 'node:path';

/**
 * Thrown when a path operation would escape its configured base directory.
 *
 * Used by {@link safeJoin} to surface path-traversal attempts (`..` segments,
 * absolute paths, null bytes, or any input that resolves outside the allowed
 * root). Callers should treat this as a 4xx-class input error rather than an
 * internal failure: the input was untrusted and rejected.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * Safely join a user-supplied relative path under a fixed base directory.
 *
 * `path.resolve` alone is INSUFFICIENT — `path.resolve('/safe', '../etc/passwd')`
 * returns `/etc/passwd`, which escapes the base. This helper performs the
 * resolve and then verifies the result lies under `baseDir + path.sep` (or
 * equals `baseDir` exactly), throwing {@link PathTraversalError} otherwise.
 *
 * Rejects:
 * - Non-string inputs.
 * - Inputs containing a NUL byte (`\0`) — some Node APIs misbehave on these.
 * - Any resolved path outside `baseDir`.
 *
 * Use this whenever an externally-supplied value (URL pathname, manifest
 * route name, upload key, config field) is concatenated with a directory
 * before being handed to `fs.*` or any other filesystem operation.
 *
 * @param baseDir - Trusted root directory. Anything resolving outside this
 *   directory will be rejected.
 * @param userPath - Relative path from `baseDir`. May come from a request,
 *   manifest, or other untrusted source.
 * @returns Absolute filesystem path under `baseDir`.
 * @throws {PathTraversalError} If the input is not a string, contains a NUL
 *   byte, or resolves outside `baseDir`.
 */
export function safeJoin(baseDir: string, userPath: string): string {
  if (typeof userPath !== 'string') {
    throw new PathTraversalError('input must be a string');
  }
  if (userPath.includes('\0')) {
    throw new PathTraversalError('null byte in path');
  }
  const baseResolved = path.resolve(baseDir);
  const resolved = path.resolve(baseResolved, userPath);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    throw new PathTraversalError(`path escapes base directory: ${userPath}`);
  }
  return resolved;
}
