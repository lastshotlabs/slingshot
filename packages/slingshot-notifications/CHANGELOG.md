# @lastshotlabs/slingshot-notifications

## 0.3.0

### Minor Changes

- d3effc1: Add opt-in version concurrency across entity contracts, memory, SQLite, PostgreSQL, and MongoDB;
  strong ETag conditional writes in runtime and generated routes; migration backfills; exhaustive
  conformance evidence; and public documentation. Redis rejects unsupported concurrency before
  infrastructure access. Notification preferences adopt optional guarded writes as the first
  production package path.

### Patch Changes

- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0
  - @lastshotlabs/slingshot-entity@0.4.0

## 0.2.12

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-entity@0.3.1

## 0.2.11

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [ec8a199]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-entity@0.3.0

## 0.2.6

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-entity@0.2.8

## 0.2.5

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.5

## 0.2.2

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.3
  - @lastshotlabs/slingshot-entity@0.2.3

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.1
  - @lastshotlabs/slingshot-entity@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
  - @lastshotlabs/slingshot-entity@0.1.1
