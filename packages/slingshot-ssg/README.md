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
- `staticPathsTimeoutMs`, which bounds how long any single `staticPaths()` /
  `generateStaticParams()` call may run before the build fails. Defaults to
  `60000`. Set this when a route's path resolver fans out to a slow upstream so
  builds fail fast instead of hanging.

## CLI Usage

The package ships a CLI binary (`slingshot-ssg`) registered via the `bin` field
in `package.json`. It is also invocable directly:

```bash
npx slingshot-ssg [options]
bun run slingshot-ssg -- [options]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--routes-dir <path>` | `server/routes` | Path to the SSR routes directory |
| `--assets-manifest <path>` | `dist/client/.vite/manifest.json` | Path to the Vite client manifest |
| `--out <path>` | `dist/static` | Output directory for `.html` files |
| `--concurrency <n>` | `4` | Parallel page render limit (max: 256) |
| `--renderer <path>` | `dist/server/entry-server.js` | Path to the SSR renderer module |
| `--client-entry <key>` | auto-detect | Vite manifest key for client entry |
| `--rsc-manifest <path>` | — | Path to RSC manifest from `snapshotSsr({ rsc: true })` |
| `--retry <n>` | `3` | Max render attempts per page for transient failures |
| `--retry-base-delay <ms>` | `1000` | Base exponential backoff delay |
| `--retry-max-delay <ms>` | `30000` | Maximum backoff delay |
| `--breaker-threshold <n>` | disabled | Consecutive failures before circuit breaker trips |
| `--breaker-cooldown <ms>` | `30000` | Circuit breaker cooldown duration |
| `--watch` | — | Watch routes directory and re-render on changes |
| `-h, --help` | — | Show help text and exit |

### Examples

```bash
# Default configuration
slingshot-ssg

# Custom output with higher concurrency
slingshot-ssg --out dist/static --concurrency 8

# With RSC support
slingshot-ssg --rsc-manifest dist/client/rsc-manifest.json

# Production-hardened: retries + circuit breaker
slingshot-ssg --retry 5 --retry-base-delay 500 --breaker-threshold 10

# Watch mode for development
slingshot-ssg --watch --concurrency 4
```

## Production Features

### Retry Logic

Transient render failures (timeout, upstream network error) are automatically
retried with exponential backoff and jitter. Configured via:

- `retry.maxAttempts` — maximum attempts per page (default: 3)
- `retry.baseDelayMs` — base delay for exponential backoff (default: 1000)
- `retry.maxDelayMs` — maximum backoff ceiling (default: 30000)

Non-transient errors (non-200 responses, unmatched routes, write failures) are
never retried — they always produce an immediate failed result.

### Circuit Breaker

When enabled, the circuit breaker guards external HTTP fetches during rendering.
If `breaker-threshold` consecutive render failures occur, the breaker opens and
subsequent pages fail fast without invoking the renderer, preventing the build
from hammering a degraded upstream service.

After `breaker-cooldown` milliseconds, the breaker transitions to half-open and
admits a single probe request. If the probe succeeds, the breaker resets; if it
fails, the breaker re-opens.

### Watch Mode

In watch mode (`--watch`), the CLI watches the routes directory for file changes
and automatically re-renders all pages. Changes are debounced at 300ms. The
process stays alive until terminated with Ctrl+C.

### Atomic File Writes

Output HTML files are written atomically: content is first written to a
temporary file, then renamed into place. If the write fails, the temporary file
is cleaned up and no partial output is left behind.

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
