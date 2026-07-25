# @lastshotlabs/slingshot-entity

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
