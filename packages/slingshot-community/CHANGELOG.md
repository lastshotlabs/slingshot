# @lastshotlabs/slingshot-community

## 0.2.12

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-entity@0.3.1
  - @lastshotlabs/slingshot-notifications@0.2.12
  - @lastshotlabs/slingshot-push@0.2.7

## 0.2.11

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [ec8a199]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-entity@0.3.0
  - @lastshotlabs/slingshot-notifications@0.2.11
  - @lastshotlabs/slingshot-push@0.2.6

## 0.2.10

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-entity@0.2.8
  - @lastshotlabs/slingshot-notifications@0.2.6
  - @lastshotlabs/slingshot-push@0.2.5

## 0.2.7

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

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.6
  - @lastshotlabs/slingshot-notifications@0.2.5
  - @lastshotlabs/slingshot-push@0.2.4

## 0.2.6

### Patch Changes

- contentTargetGuard: take the target from path params, not only the body

  The guard called `c.req.json()` unconditionally, which made it unusable on any
  GET route — with no body the parse throws and the request dies as
  `400 Invalid JSON body` before the handler runs.

  `Reaction.listByTarget` is exactly such a route
  (`GET /community/reactions/list-by-target/:targetId/:targetType`, declared with
  `fields: { targetId: 'param:targetId', targetType: 'param:targetType' }`), so
  reaction counts never loaded in a consumer app: every feed row rendered zero
  regardless of the real counts, and un-reacting was broken too, since the client
  resolves the row id for DELETE from that same response.

  The guard now reads path params first and falls back to the body, so
  body-carrying POST call sites are unchanged. `requireContainerIdMatch` is
  skipped for param-addressed requests — it exists to cross-check a
  client-asserted containerId, and a param route asserts none.

## 0.2.5

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.5
  - @lastshotlabs/slingshot-notifications@0.2.4
  - @lastshotlabs/slingshot-push@0.2.3

## 0.2.3

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.3
  - @lastshotlabs/slingshot-entity@0.2.3
  - @lastshotlabs/slingshot-notifications@0.2.2
  - @lastshotlabs/slingshot-push@0.2.2

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.1
  - @lastshotlabs/slingshot-entity@0.2.1
  - @lastshotlabs/slingshot-notifications@0.2.1
  - @lastshotlabs/slingshot-push@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
  - @lastshotlabs/slingshot-entity@0.1.1
  - @lastshotlabs/slingshot-notifications@0.1.1
  - @lastshotlabs/slingshot-push@0.1.1
