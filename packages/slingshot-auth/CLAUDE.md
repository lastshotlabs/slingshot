# slingshot-auth

Authentication package for Slingshot: sessions, JWTs, MFA, OAuth, WebAuthn, passkeys, auth
middleware, and the `/auth/*` route surface.

## Key Files

| File                       | What                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| src/index.ts               | Public API surface for plugin, middleware, adapters, and helpers     |
| src/plugin.ts              | `createAuthPlugin()` factory                                         |
| src/types/config.ts        | Top-level auth plugin config schema and exported config types        |
| src/config/authConfig.ts   | Resolved auth config helpers and shared auth option types            |
| src/lib/session/           | Session repository: interface, 5 backends, policy helpers, factories |
| src/bootstrap.ts           | Adapter/bootstrap assembly for auth runtime services                 |
| src/middleware/userAuth.ts | Request auth middleware used across the workspace                    |
| src/routes/login.ts        | Representative auth route implementation                             |
| docs/human/index.md        | Package guide synced into the docs site                              |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-postgres/src/index.ts`
- **Imported by**: `packages/slingshot-m2m/src/plugin.ts`, `packages/slingshot-oauth/src/plugin.ts`, `packages/slingshot-oidc/src/plugin.ts`, `packages/slingshot-scim/src/plugin.ts`, and `../../src/index.ts`

## Common Tasks

- **Adding an auth adapter**: add the adapter under `src/adapters/`, then wire it through `src/bootstrap.ts`
- **Changing auth config**: update `src/types/config.ts` and `src/config/authConfig.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-auth/tests/`
