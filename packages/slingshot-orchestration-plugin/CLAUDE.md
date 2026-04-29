# slingshot-orchestration-plugin

Slingshot plugin integration layer for the portable orchestration runtime. Bridges the
framework-agnostic orchestration runtime into a Slingshot app by publishing the runtime
through `ctx.pluginState`, forwarding lifecycle events onto `ctx.bus`, mounting HTTP
routes, and managing adapter startup/shutdown.

## Key Files

| File                | What                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| src/index.ts        | Public API surface: plugin factory, context helpers, event sink, validation  |
| src/plugin.ts       | `createOrchestrationPlugin()` factory with route mounting and lifecycle      |
| src/context.ts      | `getOrchestration()`, `getOrchestrationOrNull()`, plugin-state key           |
| src/routes.ts       | `createOrchestrationRouter()` Hono router with task/workflow/run endpoints   |
| src/eventSink.ts    | `createSlingshotEventSink()` bridges orchestration events onto the bus       |
| src/events.ts       | Module augmentation merging `OrchestrationEventMap` into `SlingshotEventMap` |
| src/types.ts        | Plugin option types, request context, and run authorizer contracts           |
| src/validation.ts   | `orchestrationPluginConfigSchema` for manifest-mode configuration            |
| docs/human/index.md | Package guide synced into the docs site                                      |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-core` (`getContext`, `SlingshotContext`, `PluginSetupContext`, `SlingshotPlugin`, `AppEnv`, `getActorTenantId`, `withTimeout`, `TimeoutError`, `HealthCheck`), `@lastshotlabs/slingshot-orchestration` (runtime, adapter, types, errors), `hono`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts`, `../../src/lib/pluginSchemaRegistry.ts`, and direct application use

## Common Tasks

- **Adding a route**: add the handler in `src/routes.ts` inside `createOrchestrationRouter()`, wire authorization through `canAccessRun()`, and wrap adapter calls with `withTimeout()`
- **Changing plugin options**: update `src/types.ts`, then update `src/validation.ts` for manifest mode and `docs/human/index.md`
- **Changing context resolution or authorization**: update `OrchestrationRequestContext` and `OrchestrationRunAuthorizer` in `src/types.ts`, then update `resolveRequestContext()` and `canAccessRun()` in `src/routes.ts`
- **Testing**: `packages/slingshot-orchestration-plugin/tests/`
