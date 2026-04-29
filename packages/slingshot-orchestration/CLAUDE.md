# slingshot-orchestration

Portable orchestration layer for tasks and workflows with pluggable adapter backends.
Provides `defineTask()`, `defineWorkflow()`, and `createOrchestrationRuntime()` as the
framework-agnostic composition root. Built-in memory and SQLite adapters cover local
development; production adapters live in sibling packages (BullMQ, Temporal).

## Key Files

| File                         | What                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| src/index.ts                 | Public API surface for tasks, workflows, runtime, adapters, and types   |
| src/defineTask.ts            | `defineTask()` factory with validation, kebab-case enforcement, retry   |
| src/defineWorkflow.ts        | `defineWorkflow()`, `step()`, `parallel()`, `sleep()`, `stepResult()`   |
| src/runtime.ts               | `createOrchestrationRuntime()` composition root                         |
| src/adapter.ts               | `generateRunId()`, `createCachedRunHandle()`, capability detection      |
| src/types.ts                 | Full type catalog: adapter contract, run lifecycle, events, capabilities|
| src/errors.ts                | `OrchestrationError` with machine-readable error codes                  |
| src/idempotency.ts           | `createIdempotencyScope()` key derivation for adapter implementations   |
| src/engine/taskRunner.ts     | In-process task execution engine with retry and abort                   |
| src/engine/workflowRunner.ts | In-process workflow step walker with hooks, sleep, and parallel support |
| src/adapters/memory.ts       | `createMemoryAdapter()` for tests and local development                 |
| src/adapters/sqlite.ts       | `createSqliteAdapter()` for durable single-node execution               |
| src/provider/index.ts        | Provider registry surface used by Temporal worker code generation       |
| src/provider/registry.ts     | `createOrchestrationProviderRegistry()` task/workflow manifest builder  |
| src/validation.ts            | Shared Zod validation helpers                                          |
| docs/human/index.md          | Package guide synced into the docs site                                 |

## Connections

- **Imports from**: `zod` (schema validation only; no framework dependencies)
- **Imported by**: `packages/slingshot-orchestration-bullmq`, `packages/slingshot-orchestration-temporal`, `packages/slingshot-orchestration-plugin`, manifest bootstrap via `../../src/lib/builtinPlugins.ts`, and `../../src/lib/createServerFromManifest.ts`

## Common Tasks

- **Adding an adapter**: implement the `CoreOrchestrationAdapter` contract from `src/types.ts`, optionally add capability interfaces (`SignalCapability`, `ScheduleCapability`, etc.), then export from a new package or `src/adapters/`
- **Adding a workflow entry type**: extend `WorkflowEntry` in `src/types.ts`, handle the new `_tag` in `src/engine/workflowRunner.ts`, and update `src/defineWorkflow.ts` validation
- **Changing run options or capabilities**: update `RunOptions` / `OrchestrationCapability` in `src/types.ts`, then update `src/runtime.ts` and `src/adapter.ts`
- **Testing**: `packages/slingshot-orchestration/tests/`
