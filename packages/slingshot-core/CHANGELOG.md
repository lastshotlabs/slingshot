# @lastshotlabs/slingshot-core

## 0.5.0

### Minor Changes

- e758f4e: Persist governed events atomically through explicit outbox delivery on authentic
  PostgreSQL and SQLite transaction scopes.
- 9bb9c77: Add the governed `events.consume()` API with PostgreSQL and SQLite
  transactional inbox deduplication, rollback-safe handler effects, stable named
  consumer identities, and concurrent redelivery protection.
- 935b839: Add the initial transactional event reliability contracts, configuration,
  topology validation, and PostgreSQL/SQLite outbox and inbox migrations.

### Patch Changes

- 60a6f36: Add an opt-in production adoption path that commits immediate notification
  creation with an outbox event, consumes delivery through a stable transactional
  inbox name, and forwards the event ID as the delivery-provider idempotency key.

## 0.4.0

### Minor Changes

- d3effc1: Add opt-in version concurrency across entity contracts, memory, SQLite, PostgreSQL, and MongoDB;
  strong ETag conditional writes in runtime and generated routes; migration backfills; exhaustive
  conformance evidence; and public documentation. Redis rejects unsupported concurrency before
  infrastructure access. Notification preferences adopt optional guarded writes as the first
  production package path.

### Patch Changes

- fd0069d: Serialize SQLite transaction scopes and all standard entity operations through a per-app FIFO
  coordinator so unrelated work cannot join an awaited transaction on the shared connection.
  Publish versioned SQLite/PostgreSQL transaction-manager conformance evidence and document the
  opaque scoped package-service and hook-service contract.

## 0.3.1

### Patch Changes

- 50456ec: Fail closed when AI moderation policies are configured but a generation request accidentally
  omits moderation, with an optional default policy for configure-once enforcement.

  Reconcile changed SQLite and PostgreSQL entity indexes during runtime bootstrap, quote PostgreSQL
  CRUD column identifiers, and correct the `routes.disable` authoring contract documentation.

## 0.3.0

### Minor Changes

- 0f42569: Add exhaustive entity backend capability contracts and immutable five-store profiles, reject
  unsupported standard entity configurations before adapter construction, consolidate operation
  builders on the canonical implementation, and make MongoDB and Redis create semantics preserve
  existing primary-key records with normalized conflicts.
- 79dae42: Define the public transaction scope, manager, lifecycle-error, step-result, and semantic-step
  contracts; require named native operations for semantic transaction steps; and reject malformed
  transaction topology before backend infrastructure is accessed. Dispatch semantic steps through
  their exact configured methods, resolve nested bindings, return nullable lookups, and normalize
  required mutation misses to typed HTTP conflicts.
  Expose one app-owned manager through package routes, hook services, and StoreInfra; bind entity
  resolution explicitly to opaque scopes; enforce same-store nesting, lifecycle ownership, closed
  scope safety, and pending-work rollback; cache scope-bound adapters; and defer framework search and
  entity effects until the primary transaction commits.
  Install the live PostgreSQL scope provider when the app has a configured pool; bind scoped entity
  and Drizzle adapters to one checked-out queryable, route declarative composite transactions through
  the shared manager, reject caught server-aborted work as rollback-only, and release the client
  exactly once after every lifecycle outcome.

## 0.2.4

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.

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
