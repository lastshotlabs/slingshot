---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-image
---

`@lastshotlabs/slingshot-image` handles on-the-fly image optimization behind a single Snapshot route.
It fetches an approved source image, validates transform parameters, optionally transforms with
`sharp`, and caches generated variants.

## When To Use It

Use this package when your app needs:

- responsive image resizing behind a stable app-owned endpoint
- format conversion such as AVIF, WebP, JPEG, or PNG
- origin allow-list enforcement for remote image fetches
- a default cache so repeat image variants are cheap

Do not use it as a full media pipeline. It is request-time optimization, not offline asset
processing.

## Minimum Setup

The plugin is mostly zero-config. Defaults are:

- `routePrefix: '/_snapshot/image'`
- `maxWidth: 4096`
- `maxHeight: 4096`
- `allowedOrigins: []`
- an in-memory LRU cache with `500` entries when no custom cache is provided

If `allowedOrigins` is empty, only relative URLs are effectively useful for remote safety. Add
explicit hostnames before allowing absolute upstream image URLs.

## What You Get

The plugin mounts:

- `GET {routePrefix}`

The route supports query parameters for:

- `url`
- `w`
- optional `h`
- optional `f`
- optional `q`

It also:

- validates width and height against hard upper bounds
- rejects disallowed source URLs before any fetch happens
- fetches relative paths through the current app host
- returns long-lived immutable cache headers on generated variants

When `sharp` is available, the plugin performs actual transforms. When `sharp` is absent, the
package falls back to serving originals with a warning instead of crashing startup.

## Common Customization

The main extension points are:

- `allowedOrigins` for remote-source policy
- `maxWidth` and `maxHeight` for transform limits
- `routePrefix` if your app wants a different public image URL
- `cache` if you need a custom cache adapter instead of the default in-memory LRU

If you need to change behavior, start in:

- `src/plugin.ts` for defaults and cache wiring
- `src/routes.ts` for request validation and response behavior
- `src/transform.ts` for format conversion logic
- `src/cache.ts` for the default memory cache

## Gotchas

- Width is required. Missing or invalid `w` returns `400`.
- Relative URLs are always allowed and are fetched from the current app host. Be deliberate about
  what local routes can return image bytes.
- The route validates requested dimensions against absolute limits first, then applies your plugin
  config limits during transform.
- The default cache is process-local. Multi-instance deployments need a custom shared cache if you
  want cross-instance reuse.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/config.schema.ts`
- `src/routes.ts`
- `src/transform.ts`
- `src/cache.ts`
