// packages/slingshot-ssr/src/routeSource/index.ts
//
// Barrel for the route-source surface. Adapter authors and consumers import
// from `@lastshotlabs/slingshot-ssr/routeSource` (or via the package root,
// where these symbols are also re-exported).

export type {
  ResolveRouteOptions,
  ResolveRouteChainOptions,
  SsrRouteSource,
} from './types';
export { createFileBasedRouteSource } from './fileBased';
export type { FileBasedRouteSourceConfig } from './fileBased';
