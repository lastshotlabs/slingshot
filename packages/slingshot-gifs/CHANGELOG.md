# @lastshotlabs/slingshot-gifs

## 0.4.0

### Minor Changes

- d498f62: Fetch stickers, not just GIFs.

  `kind: 'gif' | 'sticker'` is now accepted on `search()`/`trending()` and on
  the `/gifs/search` and `/gifs/trending` routes, and is carried back on every
  `GifResult`.

  Sticker responses are shaped differently from GIF responses: KLIPY and Tenor
  return `media_formats.gif_transparent` / `tinygif_transparent` and omit the
  opaque `gif` / `tinygif` keys entirely, so the response validator and mapper
  now key off the requested kind. Giphy models stickers as a sibling resource
  (`/v1/stickers/...`) rather than a filter, and is handled accordingly.

  `kind` is on the RESULT because it changes how a client must paint it — a
  sticker carries alpha and is meant to sit directly on the page rather than in
  the bordered tile a GIF wants.

  An unrecognised `?kind=` value is a 400 rather than a silent fallback to GIFs.

  BREAKING (type-level): `GifResult.kind` is required, so anything implementing
  `GifProvider` itself must set it. Reading results is unaffected, and omitting
  `kind` from a request produces byte-for-byte the request it did before.

## 0.3.2

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.6.5

## 0.3.1

### Patch Changes

- Updated dependencies [e8f67f5]
  - @lastshotlabs/slingshot-core@0.6.4

## 0.3.0

### Minor Changes

- ed49b6a: Add KLIPY as a first-class GIF search and trending provider using its Tenor-v2-compatible API.

## 0.2.11

### Patch Changes

- Updated dependencies [5402653]
  - @lastshotlabs/slingshot-core@0.6.3

## 0.2.10

### Patch Changes

- Updated dependencies [0c13b2b]
  - @lastshotlabs/slingshot-core@0.6.2

## 0.2.9

### Patch Changes

- Updated dependencies [0696379]
  - @lastshotlabs/slingshot-core@0.6.1

## 0.2.8

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0

## 0.2.7

### Patch Changes

- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0

## 0.2.6

### Patch Changes

- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0

## 0.2.5

### Patch Changes

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1

## 0.2.4

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0

## 0.2.3

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4

## 0.2.2

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.3

## 0.2.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [fcdfd18]
  - @lastshotlabs/slingshot-core@0.1.1
