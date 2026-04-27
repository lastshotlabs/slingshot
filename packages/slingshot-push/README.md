---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-push
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

@lastshotlabs/slingshot-push is the feature package in the Slingshot workspace.

Web Push (VAPID) delivery plugin for Slingshot
Push entities follow the shared package-first/entity model; `createPushPlugin()` is the runtime shell
that composes routing, providers, and manifest wiring.

## Package Boundaries

- Document which responsibilities this package owns.
- Call out which contracts come from `slingshot-core` or neighboring packages.
- Keep package-specific examples here instead of hiding them in the root docs.

## Operational Notes

- Add startup requirements, debugging tips, and failure modes.
- Record migrations when config shapes or lifecycle timing changes.

## Gotchas

- Record edge cases that surprised us.

## Key Files

- `packages/slingshot-push/src/index.ts`
