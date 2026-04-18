# runtime-node

Node-host runtime implementation for Slingshot. It bridges Slingshot runtime contracts to argon2,
better-sqlite3, Node filesystem APIs, globbing, and an HTTP server factory.

## Key Files

| File                | What                                        |
| ------------------- | ------------------------------------------- |
| src/index.ts        | `nodeRuntime()` implementation              |
| package.json        | Export surface and runtime package metadata |
| docs/human/index.md | Package guide synced into the docs site     |

## Connections

- **Imports from**: `packages/slingshot-core/src/runtime.ts`
- **Imported by**: direct application use; no workspace package has a static dependency on it

## Common Tasks

- **Changing Node runtime capabilities**: update `src/index.ts` and keep its JSDoc examples accurate
- **Changing exports or packaging**: update `package.json` and `src/index.ts` together
- **Updating docs**: search `packages/docs/src/content/docs/` for Node runtime references when behavior changes
