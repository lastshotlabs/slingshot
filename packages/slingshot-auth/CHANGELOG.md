# @lastshotlabs/slingshot-auth

## 1.0.9

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

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.6.5
  - @lastshotlabs/slingshot-postgres@0.3.9

## 1.0.8

### Patch Changes

- Updated dependencies [e8f67f5]
  - @lastshotlabs/slingshot-core@0.6.4
  - @lastshotlabs/slingshot-postgres@0.3.8

## 1.0.7

### Patch Changes

- 5402653: Add trusted soft-delete list visibility, deterministic AI result fixtures, and BullMQ 6 support.

  Entity adapters now accept `includeDeleted` consistently across all five stores without exposing
  the option through generated public list routes. AI consumer tests can build complete results with
  `makeAiResult`. BullMQ-backed event and orchestration adapters now support BullMQ 6 connection
  lifecycle, scheduler, job-id, and Redis-client APIs.

- Updated dependencies [5402653]
  - @lastshotlabs/slingshot-core@0.6.3
  - @lastshotlabs/slingshot-postgres@0.3.7

## 1.0.6

### Patch Changes

- Updated dependencies [0c13b2b]
  - @lastshotlabs/slingshot-core@0.6.2
  - @lastshotlabs/slingshot-postgres@0.3.6

## 1.0.5

### Patch Changes

- Updated dependencies [2e32296]
- Updated dependencies [0696379]
  - @lastshotlabs/slingshot-postgres@0.3.5
  - @lastshotlabs/slingshot-core@0.6.1

## 1.0.4

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0
  - @lastshotlabs/slingshot-postgres@0.3.4

## 1.0.3

### Patch Changes

- a75820f: Use one canonical session-binding fingerprint across authenticated requests and refresh rotation, honor every refresh mismatch policy without destructive rejection, and preserve application/readiness availability when the global rate-limit store is unavailable.
- 60a6f36: Add an explicit CLI path for PostgreSQL auth schema migrations, reuse the
  framework pool for auth, and fail readiness when an `assume-ready` deployment
  has a missing or stale auth schema.
- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0
  - @lastshotlabs/slingshot-postgres@0.3.3

## 1.0.2

### Patch Changes

- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0
  - @lastshotlabs/slingshot-postgres@0.3.2

## 1.0.1

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-postgres@0.3.1

## 1.0.0

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-postgres@0.3.0

## 0.2.5

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-postgres@0.2.3

## 0.2.4

### Patch Changes

- Fail production bootstrap when auth or CSRF cookies explicitly disable `Secure`, and require
  `Secure` whenever `SameSite=None` is configured. This prevents session and refresh-cookie
  transport downgrades and matches modern browser and Auth0 cookie requirements.

## 0.2.3

### Patch Changes

- Harden authentication and its supporting runtime boundaries. Auth configuration now rejects
  unknown schema-owned keys instead of silently discarding misspelled protections. The release also
  enforces full-length AES-GCM authentication tags and canonical IVs, strengthens session binding,
  refresh rotation, cookies, OAuth identity verification, bearer credentials, security headers, and
  fail-closed account-state checks, and removes dynamic-regex cache invalidation paths.

  This is a compatibility break for applications that currently pass unknown auth configuration
  keys: correct the startup validation errors using the documented field names before upgrading.

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.3
  - @lastshotlabs/slingshot-postgres@0.2.2

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.1
  - @lastshotlabs/slingshot-postgres@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
  - @lastshotlabs/slingshot-postgres@0.1.1
