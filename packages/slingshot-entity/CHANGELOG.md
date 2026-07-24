# @lastshotlabs/slingshot-entity

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
