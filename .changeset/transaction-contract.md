---
'@lastshotlabs/slingshot': minor
'@lastshotlabs/slingshot-core': minor
'@lastshotlabs/slingshot-entity': minor
'@lastshotlabs/slingshot-postgres': minor
---

Define the public transaction scope, manager, lifecycle-error, step-result, and semantic-step
contracts; require named native operations for semantic transaction steps; and reject malformed
transaction topology before backend infrastructure is accessed. Dispatch semantic steps through
their exact configured methods, resolve nested bindings, return nullable lookups, and normalize
required mutation misses to typed HTTP conflicts.
Expose one app-owned manager through package routes, hook services, and StoreInfra; bind entity
resolution explicitly to opaque scopes; enforce same-store nesting, lifecycle ownership, closed
scope safety, and pending-work rollback; cache scope-bound adapters; and defer framework search and
entity effects until the primary transaction commits.
Install the live PostgreSQL scope provider when the app has a configured pool; bind scoped entity
and Drizzle adapters to one checked-out queryable, route declarative composite transactions through
the shared manager, reject caught server-aborted work as rollback-only, and release the client
exactly once after every lifecycle outcome.
