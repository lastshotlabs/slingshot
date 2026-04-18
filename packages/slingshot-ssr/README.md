---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-ssr
---

`@lastshotlabs/slingshot-ssr` is Slingshot's server-rendering package. It owns route resolution,
server action routing, metadata routes, draft-mode routing, page-declaration support, and the
middleware that turns Slingshot context plus a renderer into HTML responses.

## When To Use It

Use this package when your app needs:

- file-based server routes rendered on the server
- route loaders that read directly from Slingshot context instead of making HTTP calls back into the app
- metadata routes such as sitemap or robots behavior
- server actions mounted under the Snapshot-compatible action endpoint
- entity-driven page declarations, renderer navigation config, or ISR
- hybrid deployments that mix SSR with pre-rendered static output

## Minimum Setup

`createSsrPlugin()` has three practical requirements:

- a renderer that satisfies the `SlingshotSsrRenderer` contract
- `serverRoutesDir`
- `assetsManifest`

After that, the most common optional config is:

- `cacheControl`
- `exclude`
- `devMode`
- `staticDir`
- `isr`
- `trustedOrigins`
- `serverActionsDir`
- `runtime`
- `draftModeSecret`
- `pages`
- `navigation`

If you use layouts, your renderer also needs `renderChain()`. That requirement is architectural, not
optional polish.

## What You Get

The plugin wires several surfaces at once:

- draft-mode routes under `/api/draft` when `draftModeSecret` is configured
- server action routing under `/_snapshot`
- metadata route registration from the server route tree
- SSR middleware that resolves routes, loads data, and renders HTML
- optional ISR invalidators stored in plugin state under `slingshot-ssr:isr`
- optional page-declaration support for renderer-owned shell/navigation experiences
- entity-event subscriptions that revalidate ISR tags for referenced pages

This is the package that makes route loaders, shell rendering, metadata, and revalidation behave as
one system instead of separate app glue.

## Common Customization

Start in these files:

- `src/plugin.ts` for lifecycle and middleware registration
- `src/config.schema.ts` for supported config and validation
- `src/types.ts` for the renderer and loader contracts
- `src/resolver.ts` and `src/pageResolver.ts` for route and page resolution
- `src/pageLoaders.ts` for loader execution
- `src/metadata/` and `src/draft/` for metadata and draft-mode behavior

The generated package reference for `slingshot-ssr` is sourced from entrypoint and type-level JSDoc,
primarily `src/index.ts` plus the exported contracts in `src/types.ts`. If you change renderer,
loader, page, metadata, draft-mode, or static-params behavior, update those comments in the same
diff rather than trying to patch generated docs afterward.

The highest-leverage decisions are usually:

- renderer contract shape
- route resolution and exclusion behavior
- ISR cache adapter choice
- server action trust policy
- whether pages are file-based, manifest-backed, or both

## Gotchas

- In production mode, startup fails if `assetsManifest` cannot be read or parsed. That is expected
  and should remain fail-closed.
- `renderChain()` is required for layouts. If the renderer only implements `render()`, nested layout
  routing will not behave correctly.
- When `pages` and ISR are both enabled, the plugin subscribes to CRUD events for referenced
  entities so tag revalidation works. Changing that path affects runtime invalidation semantics.
- `staticDir` is a serving optimization for already-generated HTML, not a replacement for the SSR
  route tree.
- The dev watcher is best-effort only. It invalidates and rebuilds the route tree when Bun's watch
  API is available.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/config.schema.ts`
- `src/types.ts`
- `src/resolver.ts`
- `src/pageResolver.ts`
- `src/pageLoaders.ts`
- `src/metadata/index.ts`

## Source-Backed Examples

- [Content Platform example](/examples/content-platform/) - SSR, draft mode, metadata, and ISR-oriented composition in `examples/content-platform/`
