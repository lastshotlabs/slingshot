# @lastshotlabs/slingshot-events

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
