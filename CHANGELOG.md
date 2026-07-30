# @lastshotlabs/slingshot

## 3.1.0

### Minor Changes

- d46d7aa: Add governed event schema versions, explicit payload-version adapters, bounded redacted
  inspection, authenticated event operator routes, mutation audit ledgers, and operator
  dashboard/runbook assets.
- 4487f74: Add migration v2 snapshots, explicit field renames, deterministic risk plans,
  approval digests, verification commands, deployment locking, and immutable
  execution ledger records.
- 0cd383b: Add explicit single/multi app tenancy, immutable execution-context snapshots,
  an instance-scoped tenant-boundary registry and conformance inventory, plus
  optional PostgreSQL row-level-security migration support.
- 2178930: Add authoritative package maturity declarations and deterministic generated
  evidence for documentation, runtime warning policy, release channels, and
  promotion enforcement.

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0
  - @lastshotlabs/slingshot-events@0.3.0
  - @lastshotlabs/slingshot-entity@0.5.0
  - @lastshotlabs/slingshot-runtime-bun@0.2.8
  - @lastshotlabs/slingshot-admin@0.2.8
  - @lastshotlabs/slingshot-auth@1.0.4
  - @lastshotlabs/slingshot-bullmq@0.3.1
  - @lastshotlabs/slingshot-community@0.2.15
  - @lastshotlabs/slingshot-deep-links@0.2.8
  - @lastshotlabs/slingshot-infra@0.2.8
  - @lastshotlabs/slingshot-interactions@0.2.11
  - @lastshotlabs/slingshot-kafka@0.3.1
  - @lastshotlabs/slingshot-mail@0.2.8
  - @lastshotlabs/slingshot-notifications@0.4.1
  - @lastshotlabs/slingshot-orchestration@0.2.8
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.8
  - @lastshotlabs/slingshot-orchestration-engine@0.2.8
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.8
  - @lastshotlabs/slingshot-organizations@1.0.4
  - @lastshotlabs/slingshot-permissions@0.2.9
  - @lastshotlabs/slingshot-postgres@0.3.4
  - @lastshotlabs/slingshot-push@2.0.1
  - @lastshotlabs/slingshot-webhooks@0.2.10

## 3.0.0

### Minor Changes

- e758f4e: Persist governed events atomically through explicit outbox delivery on authentic
  PostgreSQL and SQLite transaction scopes.
- fc3c519: Add transactional-event readiness, bounded metrics and retention, audited
  replay operations, and safe outbox/inbox CLI commands.
- 9bb9c77: Add the governed `events.consume()` API with PostgreSQL and SQLite
  transactional inbox deduplication, rollback-safe handler effects, stable named
  consumer identities, and concurrent redelivery protection.
- 71ce46f: Dispatch transactional outbox rows through acknowledged BullMQ and Kafka
  publication with SQL leases, retry backoff, dead rows, crash recovery, and
  bounded shutdown.
- 935b839: Add the initial transactional event reliability contracts, configuration,
  topology validation, and PostgreSQL/SQLite outbox and inbox migrations.

### Patch Changes

- a75820f: Use one canonical session-binding fingerprint across authenticated requests and refresh rotation, honor every refresh mismatch policy without destructive rejection, and preserve application/readiness availability when the global rate-limit store is unavailable.
- 60a6f36: Add an explicit CLI path for PostgreSQL auth schema migrations, reuse the
  framework pool for auth, and fail readiness when an `assume-ready` deployment
  has a missing or stale auth schema.
- Updated dependencies [e758f4e]
- Updated dependencies [fc3c519]
- Updated dependencies [9bb9c77]
- Updated dependencies [a75820f]
- Updated dependencies [60a6f36]
- Updated dependencies [71ce46f]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0
  - @lastshotlabs/slingshot-events@0.2.0
  - @lastshotlabs/slingshot-auth@1.0.3
  - @lastshotlabs/slingshot-postgres@0.3.3
  - @lastshotlabs/slingshot-bullmq@0.3.0
  - @lastshotlabs/slingshot-kafka@0.3.0
  - @lastshotlabs/slingshot-notifications@0.4.0
  - @lastshotlabs/slingshot-runtime-bun@0.2.7
  - @lastshotlabs/slingshot-admin@0.2.7
  - @lastshotlabs/slingshot-community@0.2.14
  - @lastshotlabs/slingshot-deep-links@0.2.7
  - @lastshotlabs/slingshot-entity@0.4.1
  - @lastshotlabs/slingshot-infra@0.2.7
  - @lastshotlabs/slingshot-interactions@0.2.10
  - @lastshotlabs/slingshot-mail@0.2.7
  - @lastshotlabs/slingshot-orchestration@0.2.7
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.7
  - @lastshotlabs/slingshot-orchestration-engine@0.2.7
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.7
  - @lastshotlabs/slingshot-organizations@1.0.3
  - @lastshotlabs/slingshot-permissions@0.2.8
  - @lastshotlabs/slingshot-push@2.0.0
  - @lastshotlabs/slingshot-webhooks@0.2.9

## 2.0.0

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
- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0
  - @lastshotlabs/slingshot-entity@0.4.0
  - @lastshotlabs/slingshot-notifications@0.3.0
  - @lastshotlabs/slingshot-runtime-bun@0.2.6
  - @lastshotlabs/slingshot-admin@0.2.6
  - @lastshotlabs/slingshot-auth@1.0.2
  - @lastshotlabs/slingshot-bullmq@0.2.6
  - @lastshotlabs/slingshot-community@0.2.13
  - @lastshotlabs/slingshot-deep-links@0.2.6
  - @lastshotlabs/slingshot-infra@0.2.6
  - @lastshotlabs/slingshot-interactions@0.2.9
  - @lastshotlabs/slingshot-kafka@0.2.6
  - @lastshotlabs/slingshot-mail@0.2.6
  - @lastshotlabs/slingshot-orchestration@0.2.6
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.6
  - @lastshotlabs/slingshot-orchestration-engine@0.2.6
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.6
  - @lastshotlabs/slingshot-organizations@1.0.2
  - @lastshotlabs/slingshot-permissions@0.2.7
  - @lastshotlabs/slingshot-postgres@0.3.2
  - @lastshotlabs/slingshot-push@1.0.0
  - @lastshotlabs/slingshot-webhooks@0.2.8

## 1.0.1

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-entity@0.3.1
  - @lastshotlabs/slingshot-runtime-bun@0.2.5
  - @lastshotlabs/slingshot-admin@0.2.5
  - @lastshotlabs/slingshot-auth@1.0.1
  - @lastshotlabs/slingshot-bullmq@0.2.5
  - @lastshotlabs/slingshot-community@0.2.12
  - @lastshotlabs/slingshot-deep-links@0.2.5
  - @lastshotlabs/slingshot-infra@0.2.5
  - @lastshotlabs/slingshot-interactions@0.2.8
  - @lastshotlabs/slingshot-kafka@0.2.5
  - @lastshotlabs/slingshot-mail@0.2.5
  - @lastshotlabs/slingshot-notifications@0.2.12
  - @lastshotlabs/slingshot-orchestration@0.2.5
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.5
  - @lastshotlabs/slingshot-orchestration-engine@0.2.5
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.5
  - @lastshotlabs/slingshot-organizations@1.0.1
  - @lastshotlabs/slingshot-permissions@0.2.6
  - @lastshotlabs/slingshot-postgres@0.3.1
  - @lastshotlabs/slingshot-push@0.2.7
  - @lastshotlabs/slingshot-webhooks@0.2.7

## 1.0.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [ec8a199]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-entity@0.3.0
  - @lastshotlabs/slingshot-postgres@0.3.0
  - @lastshotlabs/slingshot-runtime-bun@0.2.4
  - @lastshotlabs/slingshot-admin@0.2.4
  - @lastshotlabs/slingshot-auth@1.0.0
  - @lastshotlabs/slingshot-bullmq@0.2.4
  - @lastshotlabs/slingshot-community@0.2.11
  - @lastshotlabs/slingshot-deep-links@0.2.4
  - @lastshotlabs/slingshot-infra@0.2.4
  - @lastshotlabs/slingshot-interactions@0.2.7
  - @lastshotlabs/slingshot-kafka@0.2.4
  - @lastshotlabs/slingshot-mail@0.2.4
  - @lastshotlabs/slingshot-notifications@0.2.11
  - @lastshotlabs/slingshot-orchestration@0.2.4
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.4
  - @lastshotlabs/slingshot-orchestration-engine@0.2.4
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.4
  - @lastshotlabs/slingshot-organizations@1.0.0
  - @lastshotlabs/slingshot-permissions@0.2.5
  - @lastshotlabs/slingshot-push@0.2.6
  - @lastshotlabs/slingshot-webhooks@0.2.6

## 0.2.12

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-runtime-bun@0.2.3
  - @lastshotlabs/slingshot-admin@0.2.3
  - @lastshotlabs/slingshot-auth@0.2.5
  - @lastshotlabs/slingshot-bullmq@0.2.3
  - @lastshotlabs/slingshot-community@0.2.10
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-deep-links@0.2.3
  - @lastshotlabs/slingshot-entity@0.2.8
  - @lastshotlabs/slingshot-infra@0.2.3
  - @lastshotlabs/slingshot-interactions@0.2.6
  - @lastshotlabs/slingshot-kafka@0.2.3
  - @lastshotlabs/slingshot-mail@0.2.3
  - @lastshotlabs/slingshot-notifications@0.2.6
  - @lastshotlabs/slingshot-orchestration@0.2.3
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.3
  - @lastshotlabs/slingshot-orchestration-engine@0.2.3
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.3
  - @lastshotlabs/slingshot-organizations@0.2.5
  - @lastshotlabs/slingshot-permissions@0.2.4
  - @lastshotlabs/slingshot-postgres@0.2.3
  - @lastshotlabs/slingshot-push@0.2.5
  - @lastshotlabs/slingshot-webhooks@0.2.5

## 0.2.9

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-ai@0.4.0

## 0.2.8

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.6
  - @lastshotlabs/slingshot-community@0.2.7
  - @lastshotlabs/slingshot-interactions@0.2.5
  - @lastshotlabs/slingshot-notifications@0.2.5
  - @lastshotlabs/slingshot-organizations@0.2.4
  - @lastshotlabs/slingshot-push@0.2.4
  - @lastshotlabs/slingshot-webhooks@0.2.4

## 0.2.7

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-community@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-permissions@0.2.3
  - @lastshotlabs/slingshot-interactions@0.2.4

## 0.2.5

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.5
  - @lastshotlabs/slingshot-community@0.2.5
  - @lastshotlabs/slingshot-interactions@0.2.3
  - @lastshotlabs/slingshot-notifications@0.2.4
  - @lastshotlabs/slingshot-organizations@0.2.3
  - @lastshotlabs/slingshot-push@0.2.3
  - @lastshotlabs/slingshot-webhooks@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-auth@0.2.3
  - @lastshotlabs/slingshot-core@0.2.3
  - @lastshotlabs/slingshot-organizations@0.2.2
  - @lastshotlabs/slingshot-admin@0.2.2
  - @lastshotlabs/slingshot-bullmq@0.2.2
  - @lastshotlabs/slingshot-community@0.2.3
  - @lastshotlabs/slingshot-deep-links@0.2.2
  - @lastshotlabs/slingshot-entity@0.2.3
  - @lastshotlabs/slingshot-interactions@0.2.2
  - @lastshotlabs/slingshot-kafka@0.2.2
  - @lastshotlabs/slingshot-mail@0.2.2
  - @lastshotlabs/slingshot-notifications@0.2.2
  - @lastshotlabs/slingshot-orchestration@0.2.2
  - @lastshotlabs/slingshot-orchestration-bullmq@0.2.2
  - @lastshotlabs/slingshot-orchestration-engine@0.2.2
  - @lastshotlabs/slingshot-orchestration-temporal@0.2.2
  - @lastshotlabs/slingshot-permissions@0.2.2
  - @lastshotlabs/slingshot-postgres@0.2.2
  - @lastshotlabs/slingshot-push@0.2.2
  - @lastshotlabs/slingshot-webhooks@0.2.2

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
