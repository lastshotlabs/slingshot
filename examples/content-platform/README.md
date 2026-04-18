# Content Platform Example

Source-backed example for the `/examples/content-platform/` docs page.

## What it shows

- auth, permissions, notifications, search, community, and assets in one content-oriented app
- SSR plugin wiring with a minimal renderer
- SSG build script using the same route tree
- edge runtime and KV ISR adapter composition

## Files

- `src/index.ts` - server composition
- `src/renderer.ts` - minimal renderer implementation for the example
- `scripts/build-static.ts` - static build entry
- `server/routes/` - route tree used by SSR and SSG
- `client-manifest.json` - checked-in manifest placeholder for the example

## Notes

This example is intentionally minimal. The renderer is a tiny implementation that keeps the wiring
truthful without pulling in a full UI stack.
