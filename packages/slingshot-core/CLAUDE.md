# slingshot-core

Contract layer for the Slingshot workspace. Shared plugin lifecycle, context, event bus,
persistence, entity, and operation contracts live here.

## Key Files

| File                 | What                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| src/index.ts         | Public API surface for all shared Slingshot contracts                |
| src/plugin.ts        | `SlingshotPlugin`, `PluginSetupContext`, and lifecycle contracts     |
| src/context.ts       | Router context helpers and validation defaults                       |
| src/context/index.ts | `SlingshotContext`, `getContext()`, and instance-scoped state        |
| src/storeInfra.ts    | Shared repo resolution contracts and plugin-facing DI symbols        |
| src/eventBus.ts      | Event bus interface, in-process adapter, and client-safe event rules |
| src/entityConfig.ts  | Shared entity field and config types                                 |
| src/operations.ts    | Shared operation config types used by generators and runtime routing |
| docs/human/index.md  | Package guide synced into the docs site                              |

## Connections

- **Imports from**: nothing in the workspace; this is the base contract package
- **Imported by**: every feature package, all runtime packages, and the framework root `../../src/index.ts`

## Common Tasks

- **Changing plugin lifecycle contracts**: update `src/plugin.ts`, then check every plugin package and `../../src/app.ts`
- **Adding shared DI or persistence hooks**: update `src/storeInfra.ts` and any caller that resolves repos
- **Expanding entity or operation types**: update `src/entityConfig.ts` or `src/operations.ts`, then follow into `packages/slingshot-entity/src/index.ts`
