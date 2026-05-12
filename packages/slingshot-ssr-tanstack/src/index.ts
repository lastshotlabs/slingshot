// packages/slingshot-ssr-tanstack/src/index.ts
//
// Public surface of `@lastshotlabs/slingshot-ssr-tanstack`.

export { createTanStackRouteSource, type TanStackRouteSourceConfig } from './source';
export { stripServerFiles } from './vite-plugin';

// SSR loader helpers for `.server.ts` companion files. Resolve the actor,
// gate on auth/policy, and return discriminated-union envelopes that the
// slingshot-ssr middleware maps to HTTP 401 / 403 automatically.
export {
  loadActor,
  getPolicyCtx,
  requireActor,
  requireUser,
  requirePolicy,
  type Actor,
  type PolicyCtx,
} from './loaders';
