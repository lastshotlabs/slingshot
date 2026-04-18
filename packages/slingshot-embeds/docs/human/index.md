---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-embeds
---

`@lastshotlabs/slingshot-embeds` is Slingshot's server-side unfurling package. It fetches a URL on the
server, validates it against SSRF rules, parses Open Graph and related metadata, and returns a
normalized preview payload your app can render in chat, feeds, or editors.

## When To Use It

Use this package when your app needs:

- link previews for user-submitted URLs
- server-side metadata extraction so browser clients never hold the fetch logic
- a single internal endpoint that can enforce domain allow/block rules

Do not use it for arbitrary HTML scraping. It is optimized for preview metadata, not full-page
extraction pipelines.

## Minimum Setup

The package is effectively standalone. Register the plugin and call its unfurl endpoint from your
UI or app service.

All config is optional. The defaults are:

- `mountPath: '/embeds'`
- `cacheTtlMs: 300_000`
- `cacheMaxEntries: 500`
- `timeoutMs: 5000`
- `maxResponseBytes: 1_048_576`

## What You Get

The plugin mounts:

- `POST {mountPath}/unfurl`

The route accepts a JSON body with `{ url: string }` and returns normalized metadata such as:

- `title`
- `description`
- `image`
- `siteName`
- `favicon`
- `type`

It also:

- validates protocols and blocks obvious private or reserved hosts
- applies optional allow-list and block-list domain policy
- uses DNS resolution checks to reduce DNS-rebinding SSRF attacks
- caches successful unfurls in memory for the configured TTL

## Common Customization

The main knobs are:

- `allowedDomains`: restrict unfurling to trusted domains
- `blockedDomains`: always reject known-problem domains
- `timeoutMs`: keep external fetch latency under control
- `maxResponseBytes`: cap how much HTML the server will read
- `mountPath`: align the endpoint with your app's route layout

If you need to alter behavior, start in:

- `src/types.ts` for config defaults and response shape
- `src/lib/ssrfGuard.ts` for URL validation
- `src/lib/unfurl.ts` for fetch and parsing behavior
- `src/lib/htmlParser.ts` for metadata extraction rules

## Gotchas

- This package is safe-by-default only if you keep the SSRF guard intact. Do not bypass it to make
  local or internal network URLs work.
- Domain allow-lists are exact-domain or subdomain matches. Be deliberate about whether
  `example.com` should also allow `foo.example.com`.
- The cache is in-memory and per process. It reduces repeat fetches, but it is not a shared preview
  store across instances.
- The endpoint returns `502` when remote fetches fail. That is expected proxy behavior, not an
  application bug.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/types.ts`
- `src/lib/unfurl.ts`
- `src/lib/htmlParser.ts`
- `src/lib/ssrfGuard.ts`
