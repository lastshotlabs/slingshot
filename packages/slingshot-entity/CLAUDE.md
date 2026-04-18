# slingshot-entity

Entity definition and code generation package plus the runtime config-driven entity plugin
used by Slingshot feature packages.

## Key Files

| File                      | What                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| src/index.ts              | Public API surface for builders, generators, and runtime factories |
| src/createEntityPlugin.ts | Root entity plugin factory                                         |
| src/generate.ts           | Pure code generation entry point                                   |
| src/defineEntity.ts       | Entity definition API                                              |
| src/defineOperations.ts   | Custom operation definition API                                    |
| src/configDriven/index.ts | Runtime entity factories and schema generation                     |
| src/manifest/index.ts     | Manifest-facing entity exports                                     |
| docs/human/index.md       | Package guide synced into the docs site                            |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: `packages/slingshot-assets/src/index.ts`, `packages/slingshot-chat/src/index.ts`, `packages/slingshot-community/src/index.ts`, `packages/slingshot-emoji/src/index.ts`, `packages/slingshot-interactions/src/index.ts`, `packages/slingshot-notifications/src/index.ts`, `packages/slingshot-organizations/src/index.ts`, `packages/slingshot-polls/src/index.ts`, `packages/slingshot-push/src/index.ts`, `packages/slingshot-ssr/src/index.ts`, `packages/slingshot-webhooks/src/index.ts`, and `../../src/lib/builtinPlugins.ts`

## Common Tasks

- **Changing generated output**: update `src/generate.ts` or the relevant files under `src/generators/`
- **Changing runtime entity behavior**: update `src/configDriven/index.ts` or `src/createEntityPlugin.ts`
- **Testing**: `packages/slingshot-entity/tests/`
