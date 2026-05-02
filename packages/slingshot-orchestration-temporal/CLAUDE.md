# slingshot-orchestration-temporal

Temporal-backed orchestration adapter and worker supervisor for the portable Slingshot
orchestration layer. Provides signal support, cron scheduling, visibility-query-based
run listing, and deterministic workflow execution via Temporal's durable execution engine.

## Key Files

| File                           | What                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| src/index.ts                   | Public API surface: adapter, worker, validation, status map, IDs          |
| src/adapter.ts                 | `createTemporalOrchestrationAdapter()` with signals, schedules, queries   |
| src/worker.ts                  | `createTemporalOrchestrationWorker()` supervisor for Node.js workers      |
| src/workflows.ts               | Temporal workflow implementations (task wrapper, multi-step workflow)     |
| src/activities.ts              | Temporal activity implementations that execute portable task handlers     |
| src/validation.ts              | Zod schemas for adapter options, worker options, connection config        |
| src/statusMap.ts               | `mapTemporalStatus()` maps Temporal execution states to portable statuses |
| src/searchAttributes.ts        | Visibility query builder and search-attribute encoding helpers            |
| src/ids.ts                     | `deriveTemporalRunId()` deterministic workflow ID derivation              |
| src/discovery.ts               | Task/workflow definition discovery from handler modules                   |
| src/workflowModuleGenerator.ts | Code-generates the Temporal workflow module from portable definitions     |
| src/workerRegistry.ts          | Global worker-scoped task/workflow registry for Temporal sandbox          |
| src/concurrency.ts             | Concurrency control helpers for adapter operations                        |
| src/errors.ts                  | `wrapTemporalError()` and `toRunError()` error normalization              |
| src/runError.ts                | Run error extraction from Temporal failure details                        |
| docs/human/index.md            | Package guide synced into the docs site                                   |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-orchestration` (adapter contract, types, errors, `createCachedRunHandle`, provider registry), `@lastshotlabs/slingshot-orchestration/provider` (provider registry types), `@lastshotlabs/slingshot-core` (`withTimeout`), `@temporalio/client`, `@temporalio/worker`, `@temporalio/common`, `zod`
- **Imported by**: app `app.config.ts` files when configuring a Temporal-backed orchestration adapter

## Common Tasks

- **Changing adapter behavior**: update `src/adapter.ts`; keep query deduplication (`inFlightQueriesByRunId`), memo extraction, and visibility query alignment consistent
- **Changing worker bootstrap**: update `src/worker.ts` and `src/workflowModuleGenerator.ts`; the generated module must stay aligned with the workflow implementations in `src/workflows.ts`
- **Adding search attributes**: update `src/searchAttributes.ts` and add validation queries in `buildVisibilityValidationQueries()`
- **Changing validation schemas**: update `src/validation.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-orchestration-temporal/tests/` (requires Node.js; Bun is not supported for Temporal workers)
