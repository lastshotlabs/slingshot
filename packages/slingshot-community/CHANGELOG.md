# @lastshotlabs/slingshot-community

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
