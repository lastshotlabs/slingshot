---
title: Notes
description: Working notes for @lastshotlabs/slingshot-entity
---

## Current Focus Areas

- Keep the generated and runtime paths conceptually aligned so features do not behave differently depending on how they are consumed.
- Document operation semantics and route-config behavior with more small examples.
- Watch for overlap between manifest support, entity definitions, and migration planning.

## Good Next Docs

- A minimal end-to-end tutorial from `defineEntity()` to generated routes and a mounted plugin.
- A cheat sheet for which concerns belong in operations, route config, middleware, or `setupPost()`.
- A manifest parity page describing what JSON can express today versus what still requires code.

## Review Checklist

- Did a change make `generate()` less pure or harder to reason about?
- Did runtime orchestration pick up framework-private knowledge that should stay in the framework root?
- Did a new feature create a second source of truth for entity structure or operation semantics?

## Private Notes

Add `private.md` next to this file for untracked design notes, migration ideas, or rough examples.
