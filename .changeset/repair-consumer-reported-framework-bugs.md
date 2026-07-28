---
'@lastshotlabs/slingshot-ai': patch
'@lastshotlabs/slingshot-core': patch
'@lastshotlabs/slingshot-entity': patch
---

Fail closed when AI moderation policies are configured but a generation request accidentally
omits moderation, with an optional default policy for configure-once enforcement.

Reconcile changed SQLite and PostgreSQL entity indexes during runtime bootstrap, quote PostgreSQL
CRUD column identifiers, and correct the `routes.disable` authoring contract documentation.
