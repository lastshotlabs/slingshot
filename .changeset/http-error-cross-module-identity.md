---
"@lastshotlabs/slingshot-core": patch
"@lastshotlabs/slingshot": patch
---

Fix `HttpError`/`ValidationError` (401, 404, …) rendering as a generic 500 under the Node runtime.

The app-level error handler classified errors with `instanceof HttpError`. When `slingshot-core` is loaded more than once in a process — notably Node's ESM/CJS dual-instance hazard — an `HttpError` thrown by one copy is not `instanceof` the `HttpError` class imported by the handler, so genuine 401/404s fell through to a generic 500. (Bun dedupes the module, so the bug only surfaced under Node.)

`HttpError`/`ValidationError` now carry a global-symbol brand (`Symbol.for`), and the framework exposes `isHttpError`/`isValidationError` guards that recognize instances across duplicate module copies. The error handler uses the guards instead of `instanceof`.
