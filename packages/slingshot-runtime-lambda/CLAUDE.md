# slingshot-runtime-lambda

AWS Lambda runtime package for Slingshot handlers. It owns cold-start bootstrap, trigger adapters,
record-level invocation flow, and manifest-driven Lambda export wiring.

## Key Files

| File                  | What                                                              |
| --------------------- | ----------------------------------------------------------------- |
| src/index.ts          | Public API surface for Lambda runtime entrypoints                 |
| src/runtime.ts        | `createLambdaRuntime()` bootstrap caching, shutdown, and wrapping |
| src/invocationLoop.ts | Per-record invocation lifecycle, hooks, idempotency, and outcomes |
| src/triggers/index.ts | Trigger registry and adapter lookup                               |
| src/manifest.ts       | `createFunctionsFromManifest()` and manifest lambda binding wiring |
| docs/human/index.md   | Package guide synced into the docs site                           |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `../../src/manifest.ts`, `../../src/index.ts`, and `packages/slingshot-runtime-node/src/index.ts`
- **Imported by**: direct AWS Lambda entrypoints and IaC-driven function bundles

## Common Tasks

- **Changing trigger behavior**: update the relevant file under `src/triggers/` and add or extend trigger tests
- **Changing invocation lifecycle semantics**: update `src/invocationLoop.ts`, then recheck idempotency, error, and hook ordering tests
- **Changing manifest-driven function wiring**: update `src/manifest.ts` and the root manifest bootstrap docs together
