---
'@lastshotlabs/slingshot-game-engine': patch
---

Exclude GameSession's memory-only `updateContent` escape hatch from the strict entity factory,
so the backend capability check no longer rejects the whole entity at boot. Every game app
persisting to SQLite, Postgres or Mongo failed to start on `UnsupportedEntityBackendError` over
an operation nothing calls. GamePlayer already excluded its `kick` marker this way; GameSession
now matches.
