# @lastshotlabs/slingshot-events

## 0.3.2

### Patch Changes

- Updated dependencies [0c13b2b]
  - @lastshotlabs/slingshot-core@0.6.2

## 0.3.1

### Patch Changes

- 0696379: Pin owned runtime, build, and optional dependencies to the versions already selected by the lockfiles. Preserve peer compatibility ranges and workspace protocols, and enforce the distinction in CI.
- Updated dependencies [0696379]
  - @lastshotlabs/slingshot-core@0.6.1

## 0.3.0

### Minor Changes

- d46d7aa: Add governed event schema versions, explicit payload-version adapters, bounded redacted
  inspection, authenticated event operator routes, mutation audit ledgers, and operator
  dashboard/runbook assets.

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0

## 0.2.0

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

- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0

## 0.1.0

Initial transactional event reliability contracts and SQL migrations.
