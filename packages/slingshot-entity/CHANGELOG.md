# @lastshotlabs/slingshot-entity

## 0.5.5

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.6.5

## 0.5.4

### Patch Changes

- Updated dependencies [e8f67f5]
  - @lastshotlabs/slingshot-core@0.6.4

## 0.5.3

### Patch Changes

- 5402653: Add trusted soft-delete list visibility, deterministic AI result fixtures, and BullMQ 6 support.

  Entity adapters now accept `includeDeleted` consistently across all five stores without exposing
  the option through generated public list routes. AI consumer tests can build complete results with
  `makeAiResult`. BullMQ-backed event and orchestration adapters now support BullMQ 6 connection
  lifecycle, scheduler, job-id, and Redis-client APIs.

- Updated dependencies [5402653]
  - @lastshotlabs/slingshot-core@0.6.3

## 0.5.2

### Patch Changes

- 0c13b2b: Make entity list behavior safe for production consumers: honor declared default sort fields,
  support composable set/comparison/OR filters, and reject limits above the configured maximum
  instead of silently truncating results.

  Use definition-derived SQL index names, migrate legacy positional PostgreSQL indexes during
  bootstrap, and enforce tenant composite uniqueness for null single-tenant identifiers with
  `NULLS NOT DISTINCT`.

  Page through complete result sets in framework retention, cascade, auto-moderation, and
  notification-expiry paths.

- Updated dependencies [0c13b2b]
  - @lastshotlabs/slingshot-core@0.6.2

## 0.5.1

### Patch Changes

- 2e32296: Fix four consumer-reported contract gaps: include owner and size data in asset lifecycle events, expose reply listing through the community public contract, decode Postgres numeric entity fields as JavaScript numbers, and preserve suspension timestamps in Postgres user reads.
- 0696379: Pin owned runtime, build, and optional dependencies to the versions already selected by the lockfiles. Preserve peer compatibility ranges and workspace protocols, and enforce the distinction in CI.
- Updated dependencies [0696379]
  - @lastshotlabs/slingshot-core@0.6.1

## 0.5.0

### Minor Changes

- 4487f74: Add migration v2 snapshots, explicit field renames, deterministic risk plans,
  approval digests, verification commands, deployment locking, and immutable
  execution ledger records.
- 0cd383b: Add explicit single/multi app tenancy, immutable execution-context snapshots,
  an instance-scoped tenant-boundary registry and conformance inventory, plus
  optional PostgreSQL row-level-security migration support.

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0

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
- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0

## 0.3.1

### Patch Changes

- 50456ec: Fail closed when AI moderation policies are configured but a generation request accidentally
  omits moderation, with an optional default policy for configure-once enforcement.

  Reconcile changed SQLite and PostgreSQL entity indexes during runtime bootstrap, quote PostgreSQL
  CRUD column identifiers, and correct the `routes.disable` authoring contract documentation.

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1

## 0.3.0

### Minor Changes

- 0f42569: Add exhaustive entity backend capability contracts and immutable five-store profiles, reject
  unsupported standard entity configurations before adapter construction, consolidate operation
  builders on the canonical implementation, and make MongoDB and Redis create semantics preserve
  existing primary-key records with normalized conflicts.
- ec8a199: Add the public entity conformance runner, complete behavior catalog, isolated memory and SQLite drivers, and a unique-schema live PostgreSQL driver with parity fixes.
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
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0

## 0.2.8

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4

## 0.2.6

### Patch Changes

- Delete events carry the deleted record; reaction changes rescore their target

  **slingshot-entity — every delete event published an empty payload.** A route
  with `event: { key: '…', payload: ['targetId', …] }` on `delete` resolves those
  fields from the op result, and neither delete handler supplied the record: the
  config-driven executor set `{ id }`, and the bare handler set nothing at all.
  So subscribers received `{}` and could not act on a deletion. Both paths now
  read the record before deleting and publish it. The bare handler reuses the
  read the post-fetch policy pass was already doing, so a delete with a policy
  configured costs no extra query.

  **slingshot-community — `updateScore` had no caller.** Its own docstring said
  it ran "from the community plugin's bus event handler after a reaction is
  created or deleted, and from `reactionBuildAdapter`"; the former was never
  written and the latter does not exist in the package. `thread.score` and
  `thread.reactionSummary` therefore stayed `0` and `{}` however many reactions a
  thread collected, so any consumer sorting by score got an inert sort that
  looked like it worked. `community:reaction.added` / `.removed` now invoke the
  existing handler, and the `scoring` config that was parsed purely for
  validation is finally used.

  Note for consumers on the emoji vocabulary: `emojiWeights` defaults to `{}`, so
  emoji reactions are counted in `reactionSummary` but contribute `0` to `score`
  until you weight them — e.g. `scoring: { emojiWeights: { '👍': 1 } }`.

## 0.2.5

### Patch Changes

- Fix `op.transition` silently doing nothing on Postgres. `transitionPostgres`
  numbered its WHERE placeholders match-first but pushed the bind values
  from-first, so every transition ran as `WHERE id = '<from-state>' AND status =
'<uuid>'` and updated zero rows while returning HTTP 200 with a null body.
  SQLite was unaffected.

## 0.2.3

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.3

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
