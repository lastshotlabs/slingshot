---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-emoji
---

`@lastshotlabs/slingshot-emoji` adds custom emoji as a manifest-backed domain. It stores emoji
metadata as entities and expects file upload bytes to be handled by the platform upload system.

## When To Use It

Use this package when your app needs:

- org-scoped custom emoji that users can create and delete
- entity-backed emoji metadata instead of one-off tables or route handlers
- delete cascades from emoji records back into uploaded asset storage

Do not use it if you only need static built-in emoji. This package exists for managed custom emoji.

## What You Need Before Wiring It In

The plugin always depends on `slingshot-auth`.

Permissions work in one of two modes:

- pass `permissions` explicitly in plugin config, or
- register `slingshot-permissions` before this plugin so it can read shared permission state

The plugin does not upload files itself. Clients must upload the image first and then create the
emoji record using the resulting `uploadKey`.

## Minimum Setup

The most common config is:

- `mountPath`, which defaults to `/emoji`
- optional explicit `permissions`

If you omit `permissions`, the plugin declares a dependency on `slingshot-permissions` and throws at
startup if the shared state is missing.

## What You Get

The package uses `createEntityPlugin()` under the hood, so it provides the standard entity-backed
emoji CRUD surface and publishes the manifest-defined schema and operations.

It also adds package-specific behavior:

- create-time shortcode validation
- org-scoped uniqueness on `[orgId, shortcode]`
- delete cascades that remove the underlying uploaded asset from storage

The API record shape includes fields such as `name`, `shortcode`, `category`, `animated`,
`uploadKey`, and ownership metadata.

## Common Customization

The main decisions are:

- whether to supply explicit `permissions` or rely on shared permissions state
- whether to keep the default `/emoji` mount path

If you need to modify behavior, start in:

- `src/plugin.ts` for plugin composition, permissions resolution, and delete cascade logic
- `src/emoji.ts` for the entity manifest
- `src/types.ts` for config and API record contracts

## Gotchas

- Shortcodes must match `^[a-z0-9_]{2,32}$`. Uppercase names, hyphens, and one-character codes are
  rejected.
- The plugin does not own upload ingestion. Missing upload plumbing is an app integration problem,
  not an emoji-plugin feature gap.
- `presignExpirySeconds` is a deprecated legacy field. If supplied, the plugin warns and ignores it.
- Delete cascades require an upload storage adapter. Without one, the plugin logs a warning and the
  metadata row is deleted without removing the file bytes.
- Passing explicit `permissions` changes dependencies: the plugin then depends only on
  `slingshot-auth`.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/emoji.ts`
- `src/types.ts`
