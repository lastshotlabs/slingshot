// packages/slingshot-ssr-tanstack/src/index.ts
//
// Public surface of `@lastshotlabs/slingshot-ssr-tanstack`.
//
// Two exports:
//
//   - `createTanStackRouteSource()` — pass to `createSsrPackage({ routeSource })`
//     in your slingshot app. Resolves TanStack route files, pairs each with
//     its `.server.{ts,tsx}` companion, and runs the loader server-side.
//
//   - `stripServerFiles()` (also exported from `/vite`) — Vite plugin that
//     removes `.server.{ts,tsx,...}` files from the client bundle. Required
//     in any app that uses companion files; without it the client bundle
//     would import server-only modules.

export { createTanStackRouteSource, type TanStackRouteSourceConfig } from './source';
export { stripServerFiles } from './vite-plugin';
