# slingshot-oidc

OIDC discovery and JWKS plugin layered on Slingshot auth. It exposes OIDC routes and key
material helpers for standards-based identity integrations.

## Key Files

| File                | What                                          |
| ------------------- | --------------------------------------------- |
| src/index.ts        | Public API surface for plugin and OIDC router |
| src/plugin.ts       | `createOidcPlugin()` factory                  |
| src/routes/oidc.ts  | OIDC route surface                            |
| src/lib/jwks.ts     | JWKS helpers                                  |
| docs/human/index.md | Package guide synced into the docs site       |

## Connections

- **Imports from**: `packages/slingshot-auth/src/index.ts` and `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Changing discovery or key behavior**: update `src/routes/oidc.ts` and `src/lib/jwks.ts`
- **Changing exported plugin options**: update `src/plugin.ts`, then update `docs/human/index.md`
- **Updating docs**: search `packages/docs/src/content/docs/` for OIDC references when behavior changes
