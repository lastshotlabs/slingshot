---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-gifs
---

`@lastshotlabs/slingshot-gifs` is a thin server-side proxy for GIF search providers. It keeps the
provider API key on the server, normalizes provider responses, and gives clients one stable
interface whether the backend is Giphy, KLIPY, or Tenor.

## When To Use It

Use this package when your app needs:

- GIF search and trending endpoints for chat, comments, or composer UIs
- provider API keys to remain server-side
- the ability to swap between Giphy, KLIPY, and Tenor without changing client payload shape

Do not use it if you want clients to call provider APIs directly. This package exists to centralize
credentials and response normalization.

## Minimum Setup

The required config is:

- `provider: 'giphy' | 'klipy' | 'tenor'`
- `apiKey`

The optional config is:

- `rating`
- `limit`, which defaults to `25`
- `mountPath`, which defaults to `/gifs`
- `fetchTimeoutMs`, which defaults to `10000`

The package has no additional Slingshot package dependencies.

## What You Get

The plugin mounts:

- `GET {mountPath}/trending`
- `GET {mountPath}/search?q=...`

Both routes return normalized results with:

- `id`
- `url`
- `preview`
- `width`
- `height`
- `title`

The API key never leaves the server. Clients only see the normalized result set.

## KLIPY Setup

Create a test or production API key in the [KLIPY Partner Panel](https://partner.klipy.com/), then
select the provider in your Slingshot config:

```ts
import { createGifsPlugin } from '@lastshotlabs/slingshot-gifs';

const gifs = createGifsPlugin({
  provider: 'klipy',
  apiKey: process.env.KLIPY_API_KEY!,
  rating: 'medium',
});
```

The provider uses KLIPY's supported Tenor-v2-compatible API and requests `gif` plus `tinygif`
media formats for the normalized full-size and preview URLs.

## Common Customization

The highest-value knobs are:

- `provider`: choose the operational backend
- `rating`: align results with your product's content policy
- `limit`: set a stable page size for UI grids
- `mountPath`: fit the route into your app's API layout

If you need to extend provider behavior, start in:

- `src/plugin.ts` for route behavior
- `src/types.ts` for the shared provider contract
- `src/providers/giphy.ts`, `src/providers/klipy.ts`, and `src/providers/tenor.ts` for
  backend-specific mapping

## Gotchas

- Search requires the `q` query parameter and returns `400` when it is missing or blank.
- Provider-specific rating vocabularies still apply. The plugin passes `rating` through rather than
  inventing a cross-provider moderation policy.
- KLIPY requires consumer-facing attribution. Follow the
  [KLIPY integration guidance](https://klipy.com/api-overview), including the `Search KLIPY`
  search placeholder and current branding requirements.
- KLIPY test keys are intended for integration testing and have a lower request allowance than
  production keys. Request production access before launching.
- The plugin normalizes response shape, not every backend quirk. If you depend on provider-only
  fields, you are breaking the abstraction boundary.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/types.ts`
- `src/providers/giphy.ts`
- `src/providers/klipy.ts`
- `src/providers/tenor.ts`
