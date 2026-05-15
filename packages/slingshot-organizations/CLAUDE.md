# slingshot-organizations

Organizations and groups **package** with entity-backed orgs, memberships, invites,
and group relationships layered on auth and entity primitives. Authored via
`definePackage(...)` and consumed through
`createApp({ packages: [createOrganizationsPackage(...)] })`. Cross-package
consumers resolve the org service via `OrganizationsOrgServiceCap` and the reconcile
service via the `ORGANIZATIONS_RECONCILE_STATE_KEY` plugin-state slot.

## Key Files

| File                         | What                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| src/index.ts                 | Public API surface for package, entities, services, and reconcile hooks               |
| src/plugin.ts                | `createOrganizationsPackage()` factory (`SlingshotPackageDefinition`)                 |
| src/entities/modules.ts      | `buildOrganizationsEntityModules(...)` — entity modules with `manual` adapter wiring  |
| src/entities/runtime.ts      | Adapter transforms + custom-op handlers (slug, invite, cascade, list-mine, redeem)    |
| src/entities/organization.ts | Organization entity definition                                                        |
| src/entities/group.ts        | Group entity definition                                                               |
| src/orgService.ts            | OrganizationsOrgServiceCap-backed cross-package service contract                                   |
| src/reconcile.ts             | Reconcile service contract and plugin-state accessors                                 |
| src/lib/rateLimit.ts         | Invite-route rate-limit store contract + memory backend                               |
| docs/human/index.md          | Package guide synced into the docs site                                               |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-auth/src/index.ts`
- **Runtime dependencies**: requires the `slingshot-auth` plugin to publish route auth and auth runtime state on the app context
- **Imported by**: direct application use

## Common Tasks

- **Adding or changing entities**: update the relevant file under `src/entities/`, then keep `src/index.ts` exports and `src/entities/modules.ts` aligned
- **Changing runtime adapter or handler behavior**: update `src/entities/runtime.ts`, then verify the wiring in `src/entities/modules.ts`
- **Testing**: `packages/slingshot-organizations/tests/`
