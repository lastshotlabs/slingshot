# slingshot-infra

Infrastructure configuration and deployment planning package. It owns platform and infra
schemas, resource provisioner registries, scaffolding templates, and deployment helpers.

## Key Files

| File                                     | What                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| src/index.ts                             | Public API surface for config factories, registries, and scaffolding |
| src/config/platformSchema.ts             | Platform config schema and `definePlatform()`                        |
| src/config/infraSchema.ts                | Infra config schema and `defineInfra()`                              |
| src/config/resolvePlatformConfig.ts      | Platform config resolution                                           |
| src/resource/provisionerRegistry.ts      | Provisioner registry factory                                         |
| src/registry/createRegistryFromConfig.ts | Registry dispatch from config                                        |
| src/scaffold/platformTemplate.ts         | Platform scaffold generator                                          |
| docs/human/index.md                      | Package guide synced into the docs site                              |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: tooling and application setup; no workspace package has a static dependency on it

## Common Tasks

- **Adding a provisioner or registry provider**: add a new implementation file, then register it in the relevant registry factory
- **Changing infra config**: update `src/config/platformSchema.ts` or `src/config/infraSchema.ts`, then update `docs/human/index.md`
- **Changing scaffolds**: update `src/scaffold/platformTemplate.ts` or its paired infra template generator
