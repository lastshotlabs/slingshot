# runtime-edge

Edge-host runtime implementation for Slingshot. It provides Web Crypto password hashing, optional
bundled file reads, and a KV-backed ISR helper for SSR deployments.

## Key Files

| File                            | What                                               |
| ------------------------------- | -------------------------------------------------- |
| src/index.ts                    | `edgeRuntime()` implementation                     |
| src/kv-isr.ts                   | KV-backed ISR cache helper exported on the subpath |
| tests/unit/edge-runtime.test.ts | Runtime behavior coverage                          |
| docs/human/index.md             | Package guide synced into the docs site            |

## Connections

- **Imports from**: `packages/slingshot-core/src/runtime.ts` and `packages/slingshot-ssr/src/index.ts`
- **Imported by**: direct application use for SSR deployments; no workspace package has a static dependency on it

## Common Tasks

- **Changing edge runtime capabilities**: update `src/index.ts` and keep its runtime guarantees documented
- **Changing ISR cache behavior**: update `src/kv-isr.ts`, then search `packages/docs/src/content/docs/` for ISR references
- **Testing**: `packages/runtime-edge/tests/`
