---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-deep-links
---

`@lastshotlabs/slingshot-deep-links` publishes the well-known files and browser fallback routes needed
for iOS universal links and Android app links. It is a small infrastructure plugin: no entities, no
auth coupling, and no hidden state beyond the compiled route config it publishes in plugin state.

## When To Use It

Use this package when your app needs:

- `/.well-known/apple-app-site-association` for iOS universal-link ownership
- `/.well-known/assetlinks.json` for Android app-link ownership
- browser fallback redirects such as `/share/*` to a canonical web route

Do not use it as a general redirect framework. Its job is limited to native deep-link ownership and
fallback handling.

## Minimum Setup

At least one of these config sections is required:

- `apple`
- `android`
- `fallbackRedirects`

If you configure `fallbackRedirects`, you must also configure `fallbackBaseUrl`. The base URL must
use `https://` and must not have a trailing slash.

The plugin has no declared dependencies, so it can be registered anywhere in the plugin list.

## What You Get

The plugin wires three surfaces:

- `GET /.well-known/apple-app-site-association` when Apple config is present
- `GET /.well-known/assetlinks.json` when Android config is present
- configured browser fallback `GET` routes for wildcard sources such as `/share/*`

It also:

- precompiles the AASA and assetlinks payloads once at plugin construction time
- marks the two well-known routes as public paths so auth middleware skips them automatically
- warns during `setupPost` if another plugin already owns a colliding path

## Common Customization

The main config decisions are:

- `apple`: one app or an array of app targets, each with `teamId`, `bundleId`, and allowed `paths`
- `android`: one package target with `packageName` and certificate fingerprints
- `fallbackRedirects`: wildcard source-to-target mappings
- `fallbackBaseUrl`: canonical HTTPS web origin used when native handling is unavailable

If you need to change behavior, start in:

- `src/config.ts` for validation and normalization rules
- `src/routes.ts` for well-known route registration and fallback redirects
- `src/fallback.ts` for wildcard expansion logic

## Gotchas

- The config fails validation unless at least one of `apple`, `android`, or `fallbackRedirects` is
  provided.
- Fallback source patterns must end in `*`, and target patterns cannot contain `*`.
- The fallback routes issue `302` redirects. They are for browser fallback behavior, not permanent
  SEO canonicalization.
- Path collisions are warnings, not silent overrides. If another plugin owns the same route, fix
  the app-level route plan rather than relying on registration order.

## Key Files

- `src/index.ts`
- `src/config.ts`
- `src/plugin.ts`
- `src/routes.ts`
- `src/fallback.ts`
- `src/aasa.ts`
- `src/assetlinks.ts`
