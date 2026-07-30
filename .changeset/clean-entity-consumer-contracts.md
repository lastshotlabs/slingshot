---
'@lastshotlabs/slingshot-core': patch
'@lastshotlabs/slingshot-entity': patch
'@lastshotlabs/slingshot-community': patch
'@lastshotlabs/slingshot-notifications': patch
'@lastshotlabs/slingshot-webhooks': patch
---

Make entity list behavior safe for production consumers: honor declared default sort fields,
support composable set/comparison/OR filters, and reject limits above the configured maximum
instead of silently truncating results.

Use definition-derived SQL index names, migrate legacy positional PostgreSQL indexes during
bootstrap, and enforce tenant composite uniqueness for null single-tenant identifiers with
`NULLS NOT DISTINCT`.

Page through complete result sets in framework retention, cascade, auto-moderation, and
notification-expiry paths.
