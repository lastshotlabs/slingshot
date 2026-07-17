# slingshot-ssr-tanstack

TanStack Router route source for `slingshot-ssr` — lets one file-based route tree drive
both server-side rendering and the client-side router, so SSR and CSR apps share a single
source of routes.

## Key Files

| File                | What                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| src/index.ts        | Public API surface: `createTanStackRouteSource()` and loader helpers |
| src/source.ts       | Route source implementation consumed by `slingshot-ssr`              |
| src/scanner.ts      | File-based route tree scanning                                       |
| src/pathSyntax.ts   | TanStack ↔ Slingshot route path syntax translation                   |
| src/client.ts       | `./client` entrypoint for the browser router                         |
| src/vite-plugin.ts  | `./vite` entrypoint; `stripServerFiles` Vite plugin                  |
| docs/human/index.md | Package guide synced into the docs site                              |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-ssr` (route source contract), `@lastshotlabs/slingshot-core`, `@lastshotlabs/slingshot-permissions`
- **Imported by**: app `app.config.ts` files and Vite configs; no workspace package imports it directly

## Common Tasks

- **Changing route scanning or path mapping**: update `src/scanner.ts` / `src/pathSyntax.ts`
- **Changing exports or packaging**: update `package.json` `exports` and the matching entry file together
- **Testing**: `packages/slingshot-ssr-tanstack/tests/`
