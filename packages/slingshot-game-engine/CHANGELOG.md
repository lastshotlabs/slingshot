# @lastshotlabs/slingshot-game-engine

## 0.2.11

### Patch Changes

- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0
  - @lastshotlabs/slingshot-entity@0.4.1

## 0.2.10

### Patch Changes

- e86a84d: Boot game-engine packages on SQLite without recursively freezing lazy entity-adapter proxies.
- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0
  - @lastshotlabs/slingshot-entity@0.4.0

## 0.2.9

### Patch Changes

- 85e18f4: Exclude GameSession's memory-only `updateContent` escape hatch from the strict entity factory,
  so the backend capability check no longer rejects the whole entity at boot. Every game app
  persisting to SQLite, Postgres or Mongo failed to start on `UnsupportedEntityBackendError` over
  an operation nothing calls. GamePlayer already excluded its `kick` marker this way; GameSession
  now matches.
- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-entity@0.3.1

## 0.2.8

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [ec8a199]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-entity@0.3.0

## 0.2.7

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-entity@0.2.8

## 0.2.6

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.6

## 0.2.5

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
