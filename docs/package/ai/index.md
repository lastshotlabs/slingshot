---
title: AI Draft
description: AI-assisted starting point for @lastshotlabs/slingshot
---

> AI-assisted orientation for the root package. Verify behavior against `src/` and the human guide before repeating details elsewhere.

## Summary

`@lastshotlabs/slingshot` is the framework entry point. It owns manifest-to-runtime translation,
app assembly, plugin orchestration, server bootstrap, and the public convenience exports that most
Slingshot applications import first.

## Quick Map

- Package kind: Root package
- Public exports: `.`, `./mongo`, `./queue`, `./redis`, `./testing`
- API reference: /api/slingshot/
- App bootstrap: `src/app.ts`
- Server bootstrap: `src/server.ts`
- Manifest schema: `src/lib/appManifest.ts`
- Manifest conversion: `src/lib/manifestToAppConfig.ts`

## Capability Routing

- Identity and access: `packages/slingshot-auth/`, `packages/slingshot-permissions/`,
  `packages/slingshot-organizations/`, `packages/slingshot-oauth/`, `packages/slingshot-oidc/`,
  `packages/slingshot-scim/`, `packages/slingshot-m2m/`
- Community and realtime collaboration: `packages/slingshot-community/`, `packages/slingshot-chat/`,
  `packages/slingshot-notifications/`, `packages/slingshot-polls/`, `packages/slingshot-push/`
- Search: `packages/slingshot-search/`
- Rendering: `packages/slingshot-ssr/`, `packages/slingshot-ssg/`, `packages/runtime-bun/`,
  `packages/runtime-node/`, `packages/runtime-edge/`
- Assets and media: `packages/slingshot-assets/`, `packages/slingshot-image/`,
  `packages/slingshot-emoji/`, `packages/slingshot-embeds/`, `packages/slingshot-gifs/`,
  `packages/slingshot-deep-links/`
- Integrations and operations: `packages/slingshot-webhooks/`, `packages/slingshot-interactions/`,
  `packages/slingshot-mail/`, `packages/slingshot-admin/`, `packages/slingshot-infra/`

## Common Agent Tasks

- For manifest work, read `src/lib/appManifest.ts`, `src/lib/manifestToAppConfig.ts`, and
  `src/lib/createServerFromManifest.ts`.
- For plugin lifecycle issues, read `src/app.ts` plus `packages/slingshot-core/src/plugin.ts`.
- For runtime host behavior, read `src/server.ts` and the matching package under `packages/runtime-*`.
- For docs drift, update JSDoc, impacted guides in `packages/docs/src/content/docs/`, and any mapped
  surface in `slingshot-docs/documentation-impact-map.json`.

## Minimal Context Recipe

Read only enough to identify the owning files and the real behavior:

1. Read root `CLAUDE.md` for package map and task routing.
2. Read the owning package `CLAUDE.md`.
3. Read the package `src/index.ts` to see the public surface.
4. Read one config/schema file and one primary runtime/plugin file.
5. Read 1-2 tests only if behavior is still unclear.

Use the doc lanes intentionally:

- `docs/generated/` for inventories and export facts
- `docs/human/` for architecture, invariants, and integration guidance
- `docs/notes/` for active maintenance breadcrumbs
- `docs/ai/` for orientation only, not final authority

Do not scan the entire docs tree for every task. Stop once you can name the owning package, the
main code path, and the doc surfaces that must change.
