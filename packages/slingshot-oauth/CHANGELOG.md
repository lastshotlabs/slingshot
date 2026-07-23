# @lastshotlabs/slingshot-oauth

## 0.2.3

### Patch Changes

- Require HTTPS for absolute OAuth post-login redirects and redirect allowlist entries in
  production. This prevents interception of the single-use authorization code appended to the
  callback URL.

- Updated dependencies
  - @lastshotlabs/slingshot-auth@0.2.4

## 0.2.2

### Patch Changes

- Harden authentication and its supporting runtime boundaries. Auth configuration now rejects
  unknown schema-owned keys instead of silently discarding misspelled protections. The release also
  enforces full-length AES-GCM authentication tags and canonical IVs, strengthens session binding,
  refresh rotation, cookies, OAuth identity verification, bearer credentials, security headers, and
  fail-closed account-state checks, and removes dynamic-regex cache invalidation paths.

  This is a compatibility break for applications that currently pass unknown auth configuration
  keys: correct the startup validation errors using the documented field names before upgrading.

- Updated dependencies
  - @lastshotlabs/slingshot-auth@0.2.3
  - @lastshotlabs/slingshot-core@0.2.3

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-auth@0.2.1
  - @lastshotlabs/slingshot-core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
  - @lastshotlabs/slingshot-auth@0.1.1
