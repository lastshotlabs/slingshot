---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot
---

This package is the Slingshot assembly layer. It turns framework config or manifest input into a
running application by validating configuration, wiring infrastructure, sorting plugins, building
the app context, mounting routes, and attaching runtime-specific server behavior.

## What This Package Is For

Use `@lastshotlabs/slingshot` when you are:

- Bootstrapping an app with `createApp()` or `createServer()`
- Starting from `app.manifest.json` via manifest bootstrap
- Registering plugins and shared framework sections such as auth, security, SSE, or WebSocket config
- Working on the framework orchestration layer that stitches the package ecosystem together

## Platform Capability Map

Slingshot is not just auth plus a thin plugin hook. The root package is the assembly point for a
broader product surface:

- Identity and access: `slingshot-auth`, `slingshot-oauth`, `slingshot-oidc`, `slingshot-scim`,
  `slingshot-m2m`, `slingshot-permissions`, and `slingshot-organizations`
- Community and realtime collaboration: `slingshot-community`, `slingshot-chat`,
  `slingshot-notifications`, `slingshot-polls`, and `slingshot-push`
- Search and discovery: `slingshot-search`
- Rendering and delivery: `slingshot-ssr`, `slingshot-ssg`, and the runtime packages
- Media and user experience: `slingshot-assets`, `slingshot-image`, `slingshot-emoji`,
  `slingshot-embeds`, `slingshot-gifs`, and `slingshot-deep-links`
- Integration surface: `slingshot-webhooks`, `slingshot-interactions`, `slingshot-mail`,
  `slingshot-admin`, and infra tooling in `slingshot-infra`

Top-level docs should make these capabilities visible. If a major package family exists but is not
discoverable from the root docs, treat that as documentation drift.

## When To Use It

Reach for the root package when the task changes framework assembly behavior or the public app
bootstrap contract. If the task is package-local runtime logic, configuration schema, or plugin
internals, start in the owning package instead and only come back here if the integration boundary
changes.

## Minimum Setup

- A minimal app usually imports `createServer()` from this package and one or more plugins such as
  `@lastshotlabs/slingshot-auth` or `@lastshotlabs/slingshot-entity`.
- Manifest-first work must be valid through `app.manifest.json`; the code-first path is a typed
  convenience, not a separate product surface.
- If the app uses persistence, queues, SSE, or WebSockets, the root package is where those
  sections are validated and attached to the runtime.

## What You Get

- `createApp()` and `createServer()` for framework bootstrap
- Manifest validation and translation into runtime config
- Plugin dependency sorting and lifecycle execution
- Context construction, shared middleware, OpenAPI mounting, and runtime adapter wiring
- Subpath exports for storage/testing entry points such as `./mongo`, `./redis`, `./queue`, and
  `./testing`
- The assembly layer that makes the broader package ecosystem feel like one framework instead of a
  pile of unrelated plugins

## Common Customization

- Edit manifest/schema behavior in `src/lib/appManifest.ts`
- Change runtime config translation in `src/lib/manifestToAppConfig.ts`
- Change plugin orchestration in `src/app.ts`
- Change server/runtime bootstrap in `src/server.ts`
- Update docs and impact mappings whenever these surfaces change because they are cross-cutting

## Gotchas

- Manifest mode is the primary deployment surface. Code-first examples still need to reflect the
  same behavior and defaults.
- Plugins coordinate through the Slingshot context and declared dependencies, not ad hoc globals.
- Cross-cutting changes in this package almost always require docs updates in the Astro site and may
  require impact-map updates if a new surface becomes drift-prone.
- Root docs have to answer "what can this platform do?" before they answer "how does bootstrap
  work?". If discoverability is weak, package-level docs will not compensate for it.

## Key Files

- `src/index.ts`
- `src/app.ts`
- `src/server.ts`
- `src/lib/appManifest.ts`
- `src/lib/manifestToAppConfig.ts`
- `src/lib/createServerFromManifest.ts`
