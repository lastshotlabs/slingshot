# @lastshotlabs/slingshot

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-admin@0.2.1
  - @lastshotlabs/slingshot-auth@0.2.1
  - @lastshotlabs/slingshot-bullmq@0.2.1
  - @lastshotlabs/slingshot-community@0.2.1
  - @lastshotlabs/slingshot-core@0.2.1
  - @lastshotlabs/slingshot-deep-links@0.2.1
  - @lastshotlabs/slingshot-entity@0.2.1
  - @lastshotlabs/slingshot-interactions@0.2.1
  - @lastshotlabs/slingshot-kafka@0.2.1
  - @lastshotlabs/slingshot-mail@0.2.1
  - @lastshotlabs/slingshot-notifications@0.2.1
  - @lastshotlabs/slingshot-orchestration@0.2.1
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.1
  - @lastshotlabs/slingshot-orchestration-engine@0.2.1
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.1
  - @lastshotlabs/slingshot-organizations@0.2.1
  - @lastshotlabs/slingshot-permissions@0.2.1
  - @lastshotlabs/slingshot-postgres@0.2.1
  - @lastshotlabs/slingshot-push@0.2.1
  - @lastshotlabs/slingshot-webhooks@0.2.1

## 0.1.1

### Patch Changes

- fcdfd18: Fix `HttpError`/`ValidationError` (401, 404, …) rendering as a generic 500 under the Node runtime.

  The app-level error handler classified errors with `instanceof HttpError`. When `slingshot-core` is loaded more than once in a process — notably Node's ESM/CJS dual-instance hazard — an `HttpError` thrown by one copy is not `instanceof` the `HttpError` class imported by the handler, so genuine 401/404s fell through to a generic 500. (Bun dedupes the module, so the bug only surfaced under Node.)

  `HttpError`/`ValidationError` now carry a global-symbol brand (`Symbol.for`), and the framework exposes `isHttpError`/`isValidationError` guards that recognize instances across duplicate module copies. The error handler uses the guards instead of `instanceof`.

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
  - @lastshotlabs/slingshot-admin@0.1.1
  - @lastshotlabs/slingshot-auth@0.1.1
  - @lastshotlabs/slingshot-bullmq@0.1.1
  - @lastshotlabs/slingshot-community@0.1.1
  - @lastshotlabs/slingshot-deep-links@0.1.1
  - @lastshotlabs/slingshot-entity@0.1.1
  - @lastshotlabs/slingshot-interactions@0.1.1
  - @lastshotlabs/slingshot-kafka@0.1.1
  - @lastshotlabs/slingshot-mail@0.1.1
  - @lastshotlabs/slingshot-notifications@0.1.1
  - @lastshotlabs/slingshot-orchestration@0.1.1
  - @lastshotlabs/slingshot-orchestration-bullmq@0.1.1
  - @lastshotlabs/slingshot-orchestration-engine@0.1.1
  - @lastshotlabs/slingshot-orchestration-temporal@0.1.1
  - @lastshotlabs/slingshot-organizations@0.1.1
  - @lastshotlabs/slingshot-permissions@0.1.1
  - @lastshotlabs/slingshot-postgres@0.1.1
  - @lastshotlabs/slingshot-push@0.1.1
  - @lastshotlabs/slingshot-webhooks@0.1.1
