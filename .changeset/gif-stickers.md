---
'@lastshotlabs/slingshot-gifs': minor
---

Fetch stickers, not just GIFs.

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
