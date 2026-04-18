# runtime-bun

Bun-host runtime implementation for Slingshot. It provides password hashing, SQLite, filesystem,
glob, and HTTP server capabilities using Bun-native APIs.

## Key Files

| File                | What                                        |
| ------------------- | ------------------------------------------- |
| src/index.ts        | `bunRuntime()` implementation               |
| package.json        | Export surface and runtime package metadata |
| docs/human/index.md | Package guide synced into the docs site     |

## Connections

- **Imports from**: `packages/slingshot-core/src/runtime.ts`
- **Imported by**: direct application use; no workspace package has a static dependency on it

## Common Tasks

- **Changing Bun runtime capabilities**: update `src/index.ts` and keep its JSDoc examples accurate
- **Changing exports or packaging**: update `package.json` and `src/index.ts` together
- **Updating docs**: search `packages/docs/src/content/docs/` for Bun runtime references when behavior changes
