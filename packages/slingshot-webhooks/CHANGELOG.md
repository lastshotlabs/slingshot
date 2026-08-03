# @lastshotlabs/slingshot-webhooks

## 0.2.15

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.6.5
  - @lastshotlabs/slingshot-entity@0.5.5

## 0.2.14

### Patch Changes

- Updated dependencies [e8f67f5]
  - @lastshotlabs/slingshot-core@0.6.4
  - @lastshotlabs/slingshot-entity@0.5.4

## 0.2.13

### Patch Changes

- 5402653: Add trusted soft-delete list visibility, deterministic AI result fixtures, and BullMQ 6 support.

  Entity adapters now accept `includeDeleted` consistently across all five stores without exposing
  the option through generated public list routes. AI consumer tests can build complete results with
  `makeAiResult`. BullMQ-backed event and orchestration adapters now support BullMQ 6 connection
  lifecycle, scheduler, job-id, and Redis-client APIs.

- Updated dependencies [5402653]
  - @lastshotlabs/slingshot-core@0.6.3
  - @lastshotlabs/slingshot-entity@0.5.3

## 0.2.12

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
  - @lastshotlabs/slingshot-entity@0.5.2

## 0.2.11

### Patch Changes

- Updated dependencies [2e32296]
- Updated dependencies [0696379]
  - @lastshotlabs/slingshot-entity@0.5.1
  - @lastshotlabs/slingshot-core@0.6.1

## 0.2.10

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0
  - @lastshotlabs/slingshot-entity@0.5.0

## 0.2.9

### Patch Changes

- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0
  - @lastshotlabs/slingshot-entity@0.4.1

## 0.2.8

### Patch Changes

- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0
  - @lastshotlabs/slingshot-entity@0.4.0

## 0.2.7

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-entity@0.3.1

## 0.2.6

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [ec8a199]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-entity@0.3.0

## 0.2.5

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-entity@0.2.8

## 0.2.4

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.6

## 0.2.3

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
