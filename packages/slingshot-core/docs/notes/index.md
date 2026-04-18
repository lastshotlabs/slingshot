---
title: Notes
description: Working notes for @lastshotlabs/slingshot-core
---

## Current Focus Areas

- Keep contract ownership clean when new shared types appear in feature packages.
- Watch for export sprawl in `src/index.ts`; broad surface area is acceptable, but duplicated aliases and near-identical contracts are a smell.
- Keep runtime abstraction work aligned with the current Bun and Node packages so core stays interface-first.

## Good Next Docs

- A map of registrar capabilities and which package publishes each one.
- A lifecycle walkthrough from `createApp()` into plugin phases, from the point of view of core contracts.
- A shorter "how to add a new boundary contract" guide for package authors.

## Review Checklist

- Did a new feature add behavior here that should live in the framework root or a plugin?
- Did a package import a sibling plugin directly when a core contract would be cleaner?
- Did a new exported type duplicate an existing one under a slightly different name?

## Private Notes

Add `private.md` next to this file for untracked personal notes about core cleanup, contract drift, or API review work.
