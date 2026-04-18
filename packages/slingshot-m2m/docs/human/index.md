---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-m2m
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

@lastshotlabs/slingshot-m2m is the feature package in the Slingshot workspace.

Machine-to-machine (M2M) OAuth2 client credentials plugin for Slingshot

## Package Boundaries

- Document which responsibilities this package owns.
- Call out which contracts come from `slingshot-core` or neighboring packages.
- Keep package-specific examples here instead of hiding them in the root docs.

## Operational Notes

- Add startup requirements, debugging tips, and failure modes.
- Record migrations when config shapes or lifecycle timing changes.
- M2M client-secret hashing and verification should flow through `RuntimePassword`, matching the
  rest of the auth stack. Avoid direct `Bun.password` calls in library or route code.

## Gotchas

- Record edge cases that surprised us.

## Key Files

- `packages/slingshot-m2m/src/index.ts`
