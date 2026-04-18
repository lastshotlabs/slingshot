---
title: Notes
description: Working notes for @lastshotlabs/slingshot-auth
---

## Current Focus Areas

- Keep adapter capability expectations explicit as more store combinations land.
- Document which route families are always mounted versus conditionally mounted from config.
- Track any remaining places where security features rely on optional packages or runtime-specific behavior.

## Good Next Docs

- A route-family matrix showing which config flags enable each router.
- A registrar integration map showing exactly what auth publishes into core and who consumes it.
- A short threat-model page covering session binding, bearer auth, CSRF, and token rotation.

## Review Checklist

- Did a new auth feature mount routes without going through the expected middleware path?
- Did a change bypass registrar publishing and create hidden package coupling?
- Did a new adapter or feature path skip startup validation or capability checks?

## Private Notes

Add `private.md` next to this file for untracked security review notes, incident follow-ups, or migration breadcrumbs.
