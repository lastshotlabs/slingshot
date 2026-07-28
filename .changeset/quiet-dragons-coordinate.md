---
'@lastshotlabs/slingshot': patch
'@lastshotlabs/slingshot-core': patch
'@lastshotlabs/slingshot-entity': patch
---

Serialize SQLite transaction scopes and all standard entity operations through a per-app FIFO
coordinator so unrelated work cannot join an awaited transaction on the shared connection.
