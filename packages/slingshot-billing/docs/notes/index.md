---
title: Notes
description: Working notes for @lastshotlabs/slingshot-billing
---

> Notes lane for rough ideas, investigation breadcrumbs, and hand-written reminders.

## Current Follow-Ups

- Capture doc gaps discovered while touching this package.
- Anonymous donations (`requireAuth: false`) are configurable but the donate route currently
  requires a signed-in user; revisit if a consuming app needs true anonymous flow.
- A second `BillingProvider` implementation will force the config `provider` field into a
  discriminated union — the seam is ready, the schema change is the work.

## Breadcrumbs

- The Stripe webhook must stay a plain `app.post` with no `request.body` schema so the raw bytes
  reach `constructEvent` unparsed; `publicPaths`/`csrfExemptPaths` are declared on the package and
  auto-merged by the framework.
- Bun resolves the Stripe SDK's worker build; sync `constructEvent` needs the explicit
  `stripeSyncCryptoProvider` (see the human guide's Gotchas).
- `README.md` is build output copied from `docs/human/index.md` by `scripts/build.ts` — never edit
  it directly.
- Phase history (1–5: scaffold, entities+Stripe+sync, routes, webhook, capability/events) lives in
  `slingshot-specs/specs/feature.billing.md`.

## Private Notes

Create `private.md` in this folder for untracked personal notes. The repo `.gitignore` excludes it and the docs sync skips it.
