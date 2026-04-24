---
title: Notes
description: Working notes for @lastshotlabs/slingshot
---

This notes lane is for root-package maintenance work that is too tactical for the human guide but
worth keeping near the package.

## Current Follow-Ups

- Keep root-package docs aligned with `src/app.ts`, `src/server.ts`, and manifest bootstrap files.
- When a new cross-cutting surface emerges, add it to `slingshot-docs/documentation-impact-map.json`
  so docs review becomes enforceable instead of tribal.
- If `bun run docs:generate` starts creating new source doc scaffolds, replace the starter copy with
  real package guidance instead of leaving template text in the repo.
- See [Code-First Docs Reimagining](./code-first-docs-reimagining.md) for the current proposal to
  restructure the public docs around package-first and entity-first authoring.
- See [Core Docs Coverage Audit](./core-docs-coverage-audit.md) for the audited checklist of core
  framework surfaces that must have an explicit docs home before the restructure is considered ready.

## Private Notes

Create `private.md` in this folder for untracked personal notes. The repo `.gitignore` excludes it and the docs sync skips it.
