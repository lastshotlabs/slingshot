---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-scim
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

> Status: Experimental. Publish prereleases on the `next` channel until this package graduates.

## Purpose

@lastshotlabs/slingshot-scim is the feature package in the Slingshot workspace.

SCIM 2.0 user provisioning plugin for Slingshot

## Package Boundaries

- Document which responsibilities this package owns.
- Call out which contracts come from `slingshot-core` or neighboring packages.
- Keep package-specific examples here instead of hiding them in the root docs.

## Operational Notes

- Add startup requirements, debugging tips, and failure modes.
- Record migrations when config shapes or lifecycle timing changes.
- Unsupported SCIM filters must fail with `400 invalidFilter`. Do not widen
  unsupported attribute filters into full-directory reads.
- `PATCH /scim/v2/Users/:id` must prove the user exists before calling any
  adapter write methods. Unknown SCIM resources should 404 without side effects.
- SCIM provisioning should use the auth runtime's password abstraction for placeholder-password
  hashing instead of reaching for `Bun.password` directly.
- `active` updates in PatchOp payloads must be validated as booleans. Do not coerce arbitrary
  strings into disablement side effects.

## Gotchas

- Record edge cases that surprised us.

## Key Files

- `packages/slingshot-scim/src/index.ts`
