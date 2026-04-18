---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-ssg
---

`@lastshotlabs/slingshot-ssg` is Slingshot's static-generation helper package. It builds on the SSR
contracts to discover which routes should be pre-rendered, resolve concrete paths for dynamic
routes, and write static HTML output to disk.

## When To Use It

Use this package when your app needs:

- fully static output for some or all SSR routes
- build-time pre-rendering driven by the same route tree and renderer used at request time
- static pages generated from `revalidate: false` routes
- dynamic route expansion via `staticPaths()` or `generateStaticParams()`

It is a build-time library, not a runtime Slingshot plugin.

## Minimum Setup

The main inputs are the SSR renderer plus an `SsgConfig`:

- `serverRoutesDir`
- `assetsManifest`
- `outDir`

All of those paths should be absolute.

The most important optional controls are:

- `concurrency`, which defaults to `4`
- `clientEntry`, when the Vite client entry chunk does not match the common defaults

## What You Get

The package exposes two main capabilities:

- `collectSsgRoutes(config)` scans the server route tree and returns concrete URL paths to render
- `renderSsgPage()` and `renderSsgPages()` render those paths to `{outDir}/.../index.html`

The renderer prefers the full SSR chain path:

- resolve the route chain with `resolveRouteChain()`
- render with `renderer.renderChain()` when a file-based chain exists
- fall back to `renderer.resolve()` plus `renderer.render()` when no file-based chain exists

That means SSG is trying to preserve the same layout and routing semantics the SSR path uses, not
invent a separate rendering model.

## Common Customization

The important files are:

- `src/crawler.ts` for route discovery
- `src/renderer.ts` for static rendering and output writing
- `src/types.ts` for config and result contracts

The main knobs you are likely to tune are:

- which routes emit `revalidate: false`
- whether dynamic routes use `staticPaths()` or `generateStaticParams()`
- output concurrency
- client entry selection for injected asset tags

## Gotchas

- All config paths should be absolute. Relative paths are not the supported contract.
- Dynamic routes with `revalidate: false` but no `staticPaths()` or `generateStaticParams()` are
  skipped with a warning.
- Non-200 renderer responses are skipped instead of being written as static output.
- Build-time route expansion runs with a minimal load context. `getUser()` is `null`, and `bsCtx`
  is only available when the build injects `globalThis.__ssgBsCtx`.
- The package writes `index.html` files under nested directories. That output shape is deliberate
  and should stay aligned with how `slingshot-ssr` serves `staticDir` content.

## Key Files

- `src/index.ts`
- `src/crawler.ts`
- `src/renderer.ts`
- `src/types.ts`
- `src/cli.ts`
