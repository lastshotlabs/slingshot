# slingshot-organizations

Organizations and groups plugin with entity-backed orgs, memberships, invites, and group
relationships layered on auth and entity primitives.

## Key Files

| File                                  | What                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| src/index.ts                          | Public API surface for plugin, manifest, and organization types |
| src/plugin.ts                         | `createOrganizationsPlugin()` factory                           |
| src/manifest/runtime.ts               | Manifest-aware runtime helpers                                  |
| src/manifest/organizationsManifest.ts | Manifest definition exported by the package                     |
| src/entities/organization.ts          | Core organization entity definition                             |
| src/entities/group.ts                 | Group entity definition                                         |
| src/types/groups.ts                   | Group-related public types                                      |
| docs/human/index.md                   | Package guide synced into the docs site                         |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Runtime dependencies**: requires the `slingshot-auth` plugin to publish route auth and auth runtime state on the app context
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` and direct application use

## Common Tasks

- **Adding or changing entities**: update the relevant file under `src/entities/`, then keep `src/index.ts` exports current
- **Changing manifest defaults**: update `src/manifest/runtime.ts` and `src/manifest/organizationsManifest.ts`
- **Testing**: `packages/slingshot-organizations/tests/`
