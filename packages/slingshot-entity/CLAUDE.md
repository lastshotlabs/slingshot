# slingshot-entity

Entity definition and code generation package plus the runtime config-driven entity plugin
used by Slingshot feature packages.

## Key Files

| File                                                              | What                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| src/index.ts                                                      | Public API surface for builders, generators, and runtime factories |
| src/createEntityPlugin.ts                                         | Root entity plugin factory                                         |
| src/generate.ts                                                   | Pure code generation entry point                                   |
| src/defineEntity.ts                                               | Entity definition API                                              |
| src/defineOperations.ts                                           | Custom operation definition API                                    |
| src/configDriven/index.ts                                         | Runtime entity factories and schema generation                     |
| src/configDriven/backendProfiles.ts                               | Backend capability profiles and startup validation                 |
| src/testing/                                                      | Shared entity conformance catalog and backend drivers              |
| ../../scripts/entity-conformance-report.ts                        | Five-store CI evidence and release validation                      |
| ../../scripts/generate-entity-support-matrix.ts                   | Profile-driven generated support docs                              |
| ../docs/src/content/docs/entity-system/optimistic-concurrency.mdx | Public concurrency, ETag, migration, and rollout guide             |
| docs/human/index.md                                               | Package guide synced into the docs site                            |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: `packages/slingshot-assets/src/index.ts`, `packages/slingshot-chat/src/index.ts`, `packages/slingshot-community/src/index.ts`, `packages/slingshot-emoji/src/index.ts`, `packages/slingshot-interactions/src/index.ts`, `packages/slingshot-notifications/src/index.ts`, `packages/slingshot-organizations/src/index.ts`, `packages/slingshot-polls/src/index.ts`, `packages/slingshot-push/src/index.ts`, `packages/slingshot-ssr/src/index.ts`, `packages/slingshot-webhooks/src/index.ts`, and the framework root (`../../src/index.ts`, `../../src/framework/packageAuthoring.ts`, CLI commands)

## Common Tasks

- **Changing generated output**: update `src/generate.ts` or the relevant files under `src/generators/`
- **Changing runtime entity behavior**: update `src/configDriven/index.ts` or `src/createEntityPlugin.ts`
- **Changing backend support claims**: update `src/configDriven/backendProfiles.ts` and its conformance coverage
- **Proving backend behavior**: update the shared catalog and the matching driver under `src/testing/`
- **Changing transaction guarantees**: add or update the shared scoped cases and
  `TRANSACTION_GUARANTEE_CATALOG`; SQLite and PostgreSQL must both pass every declared guarantee
- **Changing optimistic concurrency**: keep adapter, migration, runtime/generated HTTP, OpenAPI,
  conformance, and `entity-system/optimistic-concurrency.mdx` behavior aligned
- **Regenerating backend support docs**: run `bun run docs:entity-support`; never edit the generated matrix by hand
- **Testing**: `packages/slingshot-entity/tests/`
