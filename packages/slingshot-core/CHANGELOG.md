# @lastshotlabs/slingshot-core

## 0.6.5

### Patch Changes

- Carry the provider's asserted `email_verified` into the account OAuth creates

  An OAuth identity could never satisfy `emailVerification.required`, so turning
  that flag on permanently locked out every social login. `findOrCreateByProvider`
  inserted the user without touching `emailVerified` (`NOT NULL DEFAULT 0`), and
  the OAuth callback then ran the verification guard against the account it had
  just created — a brand new Google sign-in 403'd at its own callback, and because
  the same check runs on every `userAuth` request, every route 403'd
  `EMAIL_NOT_VERIFIED` for the whole session. There was no code path that could
  have set the flag in between. This took a downstream app's production down for
  roughly 9.5 hours.

  The provider was asserting the address the whole time and we were dropping the
  claim.
  - `IdentityProfile.emailVerified` is new on the adapter contract. It is optional
    and additive: leaving it undefined means "the provider said nothing" and the
    local flag is untouched, so nothing about existing behaviour changes.
  - `findOrCreateByProvider` honours it in all three adapters (memory, sqlite,
    mongo). Only a literal `true` counts — an absent or false claim never marks an
    address verified, because inventing that evidence is the one error in this area
    that matters.
  - A **returning** sign-in also upgrades an account that was linked before the
    claim was carried, so existing OAuth users repair themselves on their next
    login instead of needing a migration.
  - Google and Apple are wired. Apple's claim was already parsed and verified by
    `appleIdentityToken.ts` and was being dropped at the call site; it is accepted
    as either the boolean or the string `"true"`, which is what Apple sends
    depending on the flow.

  The remaining seven providers still pass no claim, which is safe (silence leaves
  the flag untouched) and tracked separately — each needs its own answer to whether
  that provider genuinely asserts verification.

## 0.6.4

### Patch Changes

- e8f67f5: Fix the WebSocket heartbeat closing sockets it has never pinged. The sweep seeded a pong
  deadline when a socket OPENED and evaluated it before sending the ping that would refresh
  it, so with the defaults (`intervalMs` 30000, `timeoutMs` 10000) every connection was closed
  with `1001 Heartbeat timeout` roughly twice a minute. Heartbeat entries now track the ping
  awaiting an answer, so a socket is only closed once a ping it was actually sent goes
  unanswered — and `timeoutMs` may now be shorter than `intervalMs`, which makes the shipped
  defaults a working configuration. A thrown `ping()` is also contained per socket instead of
  ending that tick for every other connection.

## 0.6.3

### Patch Changes

- 5402653: Add trusted soft-delete list visibility, deterministic AI result fixtures, and BullMQ 6 support.

  Entity adapters now accept `includeDeleted` consistently across all five stores without exposing
  the option through generated public list routes. AI consumer tests can build complete results with
  `makeAiResult`. BullMQ-backed event and orchestration adapters now support BullMQ 6 connection
  lifecycle, scheduler, job-id, and Redis-client APIs.

## 0.6.2

### Patch Changes

- 0c13b2b: Make entity list behavior safe for production consumers: honor declared default sort fields,
  support composable set/comparison/OR filters, and reject limits above the configured maximum
  instead of silently truncating results.

  Use definition-derived SQL index names, migrate legacy positional PostgreSQL indexes during
  bootstrap, and enforce tenant composite uniqueness for null single-tenant identifiers with
  `NULLS NOT DISTINCT`.

  Page through complete result sets in framework retention, cascade, auto-moderation, and
  notification-expiry paths.

## 0.6.1

### Patch Changes

- 2e32296: Add `suspendedAt` to the optional `CoreAuthAdapter.getUser()` profile contract so adapters can expose the suspension timestamp already carried by `UserRecord`.
- 0696379: Pin owned runtime, build, and optional dependencies to the versions already selected by the lockfiles. Preserve peer compatibility ranges and workspace protocols, and enforce the distinction in CI.

## 0.6.0

### Minor Changes

- d46d7aa: Add governed event schema versions, explicit payload-version adapters, bounded redacted
  inspection, authenticated event operator routes, mutation audit ledgers, and operator
  dashboard/runbook assets.
- 4487f74: Add migration v2 snapshots, explicit field renames, deterministic risk plans,
  approval digests, verification commands, deployment locking, and immutable
  execution ledger records.
- 0cd383b: Add explicit single/multi app tenancy, immutable execution-context snapshots,
  an instance-scoped tenant-boundary registry and conformance inventory, plus
  optional PostgreSQL row-level-security migration support.
- 2178930: Add authoritative package maturity declarations and deterministic generated
  evidence for documentation, runtime warning policy, release channels, and
  promotion enforcement.

## 0.5.0

### Minor Changes

- e758f4e: Persist governed events atomically through explicit outbox delivery on authentic
  PostgreSQL and SQLite transaction scopes.
- 9bb9c77: Add the governed `events.consume()` API with PostgreSQL and SQLite
  transactional inbox deduplication, rollback-safe handler effects, stable named
  consumer identities, and concurrent redelivery protection.
- 935b839: Add the initial transactional event reliability contracts, configuration,
  topology validation, and PostgreSQL/SQLite outbox and inbox migrations.

### Patch Changes

- 60a6f36: Add an opt-in production adoption path that commits immediate notification
  creation with an outbox event, consumes delivery through a stable transactional
  inbox name, and forwards the event ID as the delivery-provider idempotency key.

## 0.4.0

### Minor Changes

- d3effc1: Add opt-in version concurrency across entity contracts, memory, SQLite, PostgreSQL, and MongoDB;
  strong ETag conditional writes in runtime and generated routes; migration backfills; exhaustive
  conformance evidence; and public documentation. Redis rejects unsupported concurrency before
  infrastructure access. Notification preferences adopt optional guarded writes as the first
  production package path.

### Patch Changes

- fd0069d: Serialize SQLite transaction scopes and all standard entity operations through a per-app FIFO
  coordinator so unrelated work cannot join an awaited transaction on the shared connection.
  Publish versioned SQLite/PostgreSQL transaction-manager conformance evidence and document the
  opaque scoped package-service and hook-service contract.

## 0.3.1

### Patch Changes

- 50456ec: Fail closed when AI moderation policies are configured but a generation request accidentally
  omits moderation, with an optional default policy for configure-once enforcement.

  Reconcile changed SQLite and PostgreSQL entity indexes during runtime bootstrap, quote PostgreSQL
  CRUD column identifiers, and correct the `routes.disable` authoring contract documentation.

## 0.3.0

### Minor Changes

- 0f42569: Add exhaustive entity backend capability contracts and immutable five-store profiles, reject
  unsupported standard entity configurations before adapter construction, consolidate operation
  builders on the canonical implementation, and make MongoDB and Redis create semantics preserve
  existing primary-key records with normalized conflicts.
- 79dae42: Define the public transaction scope, manager, lifecycle-error, step-result, and semantic-step
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

## 0.2.4

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.

## 0.2.3

### Patch Changes

- Harden authentication and its supporting runtime boundaries. Auth configuration now rejects
  unknown schema-owned keys instead of silently discarding misspelled protections. The release also
  enforces full-length AES-GCM authentication tags and canonical IVs, strengthens session binding,
  refresh rotation, cookies, OAuth identity verification, bearer credentials, security headers, and
  fail-closed account-state checks, and removes dynamic-regex cache invalidation paths.

  This is a compatibility break for applications that currently pass unknown auth configuration
  keys: correct the startup validation errors using the documented field names before upgrading.

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.

## 0.1.1

### Patch Changes

- fcdfd18: Fix `HttpError`/`ValidationError` (401, 404, …) rendering as a generic 500 under the Node runtime.

  The app-level error handler classified errors with `instanceof HttpError`. When `slingshot-core` is loaded more than once in a process — notably Node's ESM/CJS dual-instance hazard — an `HttpError` thrown by one copy is not `instanceof` the `HttpError` class imported by the handler, so genuine 401/404s fell through to a generic 500. (Bun dedupes the module, so the bug only surfaced under Node.)

  `HttpError`/`ValidationError` now carry a global-symbol brand (`Symbol.for`), and the framework exposes `isHttpError`/`isValidationError` guards that recognize instances across duplicate module copies. The error handler uses the guards instead of `instanceof`.
