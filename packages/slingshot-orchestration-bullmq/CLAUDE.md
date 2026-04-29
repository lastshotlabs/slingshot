# slingshot-orchestration-bullmq

BullMQ-backed orchestration adapter for the portable Slingshot orchestration layer. Use
this adapter when the app already runs Redis and wants durable queues, repeatable schedules,
and worker-based task execution without changing task or workflow definitions.

## Key Files

| File                  | What                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| src/index.ts          | Public API surface: adapter factory, processors, validation, status mapping   |
| src/adapter.ts        | `createBullMQOrchestrationAdapter()` factory with lazy start, cancellation,   |
|                       | run-id caching, graceful drain, scheduling, and observability                 |
| src/taskWorker.ts     | `createBullMQTaskProcessor()` for BullMQ task workers with error classification|
| src/workflowWorker.ts | `createBullMQWorkflowProcessor()` step walker dispatching child task jobs      |
| src/taskRuntime.ts    | Task retry/timeout config resolution and BullMQ backoff strategy              |
| src/statusMap.ts      | `mapBullMQStatus()` maps BullMQ job states to portable run statuses           |
| src/validation.ts     | Zod schemas for adapter options, TLS, and job retention settings              |
| docs/human/index.md   | Package guide synced into the docs site                                       |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-orchestration` (adapter contract, types, errors, `generateRunId`, `createCachedRunHandle`, `createIdempotencyScope`), `@lastshotlabs/slingshot-core` (`Logger`, `noopLogger`, `withTimeout`), `bullmq`, `zod`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` when `adapter.type === 'bullmq'`

## Common Tasks

- **Changing adapter behavior**: update `src/adapter.ts`; keep cancellation snapshot logic, lazy-start state machine, and graceful drain behavior consistent
- **Changing retry or task runtime options**: update `src/taskRuntime.ts` and the corresponding Zod schema in `src/validation.ts`
- **Adding adapter metrics**: extend `BullMQOrchestrationAdapterMetrics` in `src/adapter.ts` and update `getMetrics()`
- **Testing**: `packages/slingshot-orchestration-bullmq/tests/`
