---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-oauth
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

> Status: Experimental. Publish prereleases on the `next` channel until this package graduates.

## Purpose

@lastshotlabs/slingshot-oauth is the feature package in the Slingshot workspace.

Social OAuth login plugin for Slingshot

## Package Boundaries

- Document which responsibilities this package owns.
- Call out which contracts come from `slingshot-core` or neighboring packages.
- Keep package-specific examples here instead of hiding them in the root docs.

## Operational Notes

- Public OAuth login initiation is protected by CSRF because the package mounts `POST /auth/:provider` instead of legacy `GET` initiators.
- Session-bound provider linking, unlinking, and OAuth re-auth routes must fail closed when the account becomes suspended or no longer satisfies required email verification. Do not rely on identify middleware alone for this.
- OAuth callback continuations must not complete provider linking or mint re-auth proof for stale suspended sessions.

## Gotchas

- Provider linking and re-auth are continuation flows. Guard both the initiation route and the callback route so a long-lived browser tab cannot finish a sensitive flow after account policy changed.

## Key Files

- `packages/slingshot-oauth/src/index.ts`
