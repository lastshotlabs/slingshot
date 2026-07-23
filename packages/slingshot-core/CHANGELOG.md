# @lastshotlabs/slingshot-core

## 0.2.3

### Patch Changes

- Harden authentication and its supporting runtime boundaries. Auth configuration now rejects
  unknown schema-owned keys instead of silently discarding misspelled protections. The release also
  enforces full-length AES-GCM authentication tags and canonical IVs, strengthens session binding,
  refresh rotation, cookies, OAuth identity verification, bearer credentials, security headers, and
  fail-closed account-state checks, and removes dynamic-regex cache invalidation paths.

  This is a compatibility break for applications that currently pass unknown auth configuration
  keys: correct the startup validation errors using the documented field names before upgrading.

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.

## 0.1.1

### Patch Changes

- fcdfd18: Fix `HttpError`/`ValidationError` (401, 404, …) rendering as a generic 500 under the Node runtime.

  The app-level error handler classified errors with `instanceof HttpError`. When `slingshot-core` is loaded more than once in a process — notably Node's ESM/CJS dual-instance hazard — an `HttpError` thrown by one copy is not `instanceof` the `HttpError` class imported by the handler, so genuine 401/404s fell through to a generic 500. (Bun dedupes the module, so the bug only surfaced under Node.)

  `HttpError`/`ValidationError` now carry a global-symbol brand (`Symbol.for`), and the framework exposes `isHttpError`/`isValidationError` guards that recognize instances across duplicate module copies. The error handler uses the guards instead of `instanceof`.
