---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-orchestration
---

This package provides the portable orchestration contract for Slingshot.

It owns:

- `defineTask()` and `defineWorkflow()` for application authoring
- `step()`, `parallel()`, `sleep()`, and `stepResult()` for workflow composition
- `createOrchestrationRuntime()` for framework-agnostic runtime composition
- `createMemoryAdapter()` for in-process execution
- `createSqliteAdapter()` for durable single-node execution

It does not depend on Slingshot plugin lifecycle or Hono routing. Slingshot-specific integration
lives in `@lastshotlabs/slingshot-orchestration-plugin`.

## Mental model

- A `task` is a named, retryable unit of work with Zod-validated input and output.
- A `workflow` is an ordered array of entries that can run sequentially, in parallel, or pause with `sleep()`.
- The runtime is portable. It can run in tests, workers, plain scripts, or inside Slingshot.
- The adapter decides durability and infrastructure concerns. Task and workflow definitions stay the same.

## Supported adapters in this package

- `memory`: zero infrastructure, non-durable, best for tests and local development
- `sqlite`: durable single-node execution, process-restart recovery, no external services

## Current non-goals

- No direct Slingshot plugin lifecycle in this package
- No Hono HTTP router in this package
- No manifest integration in this package
- No Temporal or Trigger.dev support in this package

Those concerns live in outer adapters or later phases.

## Recommended usage

For standalone runtime composition:

```ts
import {
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
} from '@lastshotlabs/slingshot-orchestration';
```

For Slingshot integration, use `@lastshotlabs/slingshot-orchestration-plugin` and treat this
package as the domain layer only.

## Minimal example

```ts
import { z } from 'zod';
import {
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
  defineWorkflow,
  step,
  stepResult,
} from '@lastshotlabs/slingshot-orchestration';

const quoteCarrier = defineTask({
  name: 'quote-carrier',
  input: z.object({ quoteId: z.string(), carrier: z.string() }),
  output: z.object({ carrier: z.string(), premiumCents: z.number().int() }),
  async handler(input) {
    return { carrier: input.carrier, premiumCents: 12500 };
  },
});

const quoteWorkflow = defineWorkflow({
  name: 'quote-policy',
  input: z.object({ quoteId: z.string(), carrier: z.string() }),
  output: z.object({ carrier: z.string(), premiumCents: z.number().int() }),
  outputMapper(results) {
    return stepResult(results, 'quote', quoteCarrier)!;
  },
  steps: [step('quote', quoteCarrier)],
});

const runtime = createOrchestrationRuntime({
  adapter: createMemoryAdapter({ concurrency: 10 }),
  tasks: [quoteCarrier],
  workflows: [quoteWorkflow],
});

const handle = await runtime.runWorkflow(
  quoteWorkflow,
  { quoteId: 'q_123', carrier: 'acme' },
  { tenantId: 'tenant-a', idempotencyKey: 'quote:q_123' },
);

const output = await handle.result();
const run = await runtime.getRun(handle.id);
```

## Adapter choice

- `memory`: fastest iteration path, in-process only, no durability, good for tests and local development.
- `sqlite`: durable single-node execution, process restart recovery, good for one-node backoffice or embedded installs.
- `bullmq` via `@lastshotlabs/slingshot-orchestration-bullmq`: Redis-backed multi-worker execution and scheduling.
- `temporal` via `@lastshotlabs/slingshot-orchestration-temporal`: strongest fit for enterprise durability, signals, and distributed workflow control.

## Registration model

This package registers orchestration definitions, not application services.

- Register tasks and workflows by passing them into `createOrchestrationRuntime({ tasks, workflows, adapter })`.
- In Slingshot apps, pass the same definitions into `createOrchestrationPlugin()` or reference exported handler names from manifest config.
- Keep quote engines, carrier clients, rating services, ordering services, and document generators as normal application dependencies. Call them inside task handlers instead of trying to register them with the orchestration runtime.

## Runtime surface

- `runTask()` and `runWorkflow()` start work and return a `RunHandle`.
- `handle.result()` waits for the final output.
- `getRun(id)` returns the current portable run snapshot.
- `cancelRun(id)` requests cancellation.
- `listRuns()` and `onProgress()` are adapter capabilities, so check `runtime.supports(...)` when you depend on them.

## Contract notes

- task retry policies and task-level concurrency are validated when you call `defineTask()`
- step retry and timeout overrides are validated when you call `step()`
- dynamic `sleep()` durations are validated at workflow execution time, so invalid mapper output
  fails the run consistently across adapters instead of silently turning into an immediate timer
- adapter-level idempotency is scoped by run type, definition name, and `tenantId`, so the same
  key can be reused safely across different tenants or different task/workflow definitions
- reusing an idempotency key in the same scope returns the existing run handle; completed runs
  replay the stored result instead of failing because the original promise is no longer active
- `tenantId`, `tags`, and `metadata` are adapter-portable run options, so use them for auditability
  and request correlation instead of baking routing concerns into task names
