---
'@lastshotlabs/slingshot': patch
'@lastshotlabs/slingshot-auth': patch
'@lastshotlabs/slingshot-postgres': patch
---

Add an explicit CLI path for PostgreSQL auth schema migrations, reuse the
framework pool for auth, and fail readiness when an `assume-ready` deployment
has a missing or stale auth schema.
