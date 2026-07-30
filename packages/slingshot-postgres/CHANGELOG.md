# @lastshotlabs/slingshot-postgres

## 0.3.3

### Patch Changes

- 60a6f36: Add an explicit CLI path for PostgreSQL auth schema migrations, reuse the
  framework pool for auth, and fail readiness when an `assume-ready` deployment
  has a missing or stale auth schema.
- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0

## 0.3.2

### Patch Changes

- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1

## 0.3.0

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
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0

## 0.2.3

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4

## 0.2.2

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
