# slingshot-oauth

Social OAuth login plugin layered on Slingshot auth. It adds OAuth-specific route wiring and
plugin assembly around the shared auth runtime.

## Key Files

| File                | What                                           |
| ------------------- | ---------------------------------------------- |
| src/index.ts        | Public API surface for plugin and OAuth router |
| src/plugin.ts       | `createOAuthPlugin()` factory                  |
| src/routes/oauth.ts | OAuth route surface                            |
| docs/human/index.md | Package guide synced into the docs site        |

## Connections

- **Imports from**: `packages/slingshot-auth/src/index.ts` and `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Changing OAuth route behavior**: update `src/routes/oauth.ts`, then confirm `src/plugin.ts` still mounts the correct surface
- **Changing exported options**: update `src/plugin.ts` and `src/index.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-oauth/tests/`
