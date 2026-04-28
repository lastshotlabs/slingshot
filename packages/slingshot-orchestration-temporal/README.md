---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-orchestration-temporal
---

## What This Package Is For

`@lastshotlabs/slingshot-orchestration-temporal` is the Temporal provider package for Slingshot
orchestration. It keeps the task/workflow authoring surface portable while delegating durable
execution, timers, retries, schedules, visibility, and worker coordination to Temporal.

## When To Use It

- Use it when orchestration runs must survive process restarts and execute across multiple machines.
- Use it when a workflow needs Temporal-native scheduling, signals, or queryable history.
- Prefer memory or SQLite for local-only development where you do not need external infrastructure.
- Prefer BullMQ when Redis is already your queue backbone and you do not need Temporal semantics.

## Minimum Setup

- A Temporal service or Temporal Cloud namespace
- `@temporalio/client` on the server side
- `@temporalio/worker` on the worker side
- `@lastshotlabs/slingshot-orchestration` for the portable task/workflow definitions

```ts
import { Client, Connection } from '@temporalio/client';
import { z } from 'zod';
import {
  defineTask,
  defineWorkflow,
  step,
  stepResult,
} from '@lastshotlabs/slingshot-orchestration';
import {
  createTemporalOrchestrationAdapter,
  createTemporalOrchestrationWorker,
} from '@lastshotlabs/slingshot-orchestration-temporal';

const sendWelcomeEmail = defineTask({
  name: 'send-welcome-email',
  input: z.object({ email: z.string().email() }),
  output: z.object({ ok: z.boolean(), email: z.string().email() }),
  async handler(input) {
    return { ok: true, email: input.email };
  },
});

const onboardUser = defineWorkflow({
  name: 'onboard-user',
  input: z.object({ email: z.string().email() }),
  output: z.object({ ok: z.boolean(), email: z.string().email() }),
  outputMapper(results) {
    return stepResult(results, 'send-email', sendWelcomeEmail)!;
  },
  steps: [step('send-email', sendWelcomeEmail)],
});

const connection = await Connection.connect({ address: 'localhost:7233' });
const client = new Client({ connection, namespace: 'default' });

const adapter = createTemporalOrchestrationAdapter({
  client,
  connection,
  namespace: 'default',
  workflowTaskQueue: 'slingshot-workflows',
  defaultActivityTaskQueue: 'email-activities',
  ownsConnection: false,
});

const worker = await createTemporalOrchestrationWorker({
  connection,
  namespace: 'default',
  workflowTaskQueue: 'slingshot-workflows',
  defaultActivityTaskQueue: 'email-activities',
  buildId: 'dev-build-1',
  definitionsModulePath: new URL('./definitions.ts', import.meta.url).pathname,
});

void worker.run();
```

## What You Get

- `createTemporalOrchestrationAdapter()` for server-side orchestration control
- `createTemporalOrchestrationWorker()` for Node worker bootstrap
- generated workflow-module support for handlers-directory and manifest worker bootstraps
- deterministic run ID derivation and Temporal search-attribute helpers
- adapter and worker validation schemas for manifest/code-first setup

## Enterprise fit

- Choose Temporal when workflow state is a system of record, not just a job queue.
- Choose Temporal when long-running quoting, underwriting, ordering, approval, or fulfillment flows need durable timers, signals, and queryable execution history.
- Keep domain services outside the adapter. Temporal still runs the same portable task and workflow definitions from `@lastshotlabs/slingshot-orchestration`; your worker loads those definitions and task handlers call your real service layer.

## Common Customization

- Choose separate `workflowTaskQueue` and `defaultActivityTaskQueue` values when workflow execution
  and activity execution should scale independently.
- Use `namespace` per environment or deployment boundary.
- Use `taskNames` and `workflowNames` on the worker when a process should poll only part of the
  orchestration surface.
- Set `generatedWorkflowsDir` when you want generated workflow bundles in a predictable location.
- Attach an `eventSink` if workflow/task lifecycle events should be mirrored back into Slingshot.

## Sensitive Data: Payload Codecs

Both the adapter and the worker accept a `dataConverter` slot for installing a custom Temporal
`DataConverter` — most commonly a payload codec for PII redaction at the Temporal boundary. Pass
the same converter to the `Client` you hand to the adapter and to `createTemporalOrchestrationWorker`
so encoded payloads round-trip cleanly.

```ts
import { Client, Connection, defaultPayloadConverter } from '@temporalio/client';
import type { DataConverter } from '@temporalio/common';
import {
  createTemporalOrchestrationAdapter,
  createTemporalOrchestrationWorker,
} from '@lastshotlabs/slingshot-orchestration-temporal';

// Your codec implements `PayloadCodec` and lives at a path the worker can require.
const dataConverter: DataConverter = {
  payloadConverter: defaultPayloadConverter,
  payloadCodecs: [
    /* your encrypting / redacting codec */
  ],
};

const connection = await Connection.connect({ address: 'localhost:7233' });
const client = new Client({ connection, namespace: 'default', dataConverter });

const adapter = createTemporalOrchestrationAdapter({
  client,
  connection,
  workflowTaskQueue: 'slingshot-workflows',
  dataConverter, // documents the symmetric converter the Client was built with
});

const worker = await createTemporalOrchestrationWorker({
  connection,
  workflowTaskQueue: 'slingshot-workflows',
  buildId: 'dev-build-1',
  definitionsModulePath: new URL('./definitions.ts', import.meta.url).pathname,
  dataConverter, // applied to every Worker the supervisor creates
});
```

## Interceptors

The `interceptors` slot accepts the union of `ClientInterceptors` and `WorkerInterceptors`
(`workflowModules`, `activityInbound`, `activity`). Use it for auth-header injection, tracing,
or workflow-module interceptors:

```ts
const adapter = createTemporalOrchestrationAdapter({
  client,
  workflowTaskQueue: 'slingshot-workflows',
  interceptors: {
    workflow: [
      /* ClientInterceptors.workflow */
    ],
  },
});

const worker = await createTemporalOrchestrationWorker({
  connection,
  workflowTaskQueue: 'slingshot-workflows',
  buildId: 'dev-build-1',
  definitionsModulePath: new URL('./definitions.ts', import.meta.url).pathname,
  interceptors: {
    workflowModules: [require.resolve('./my-wf-interceptor')],
    activityInbound: [
      /* factories */
    ],
  },
});
```

## Gotchas

- Temporal workers must run on real Node.js. Bun is not supported for worker startup.
- The adapter does not start workers for you. Server and worker lifecycle are intentionally separate.
- If the adapter owns the Temporal connection, make sure shutdown responsibility is clear.
- Manifest mode still needs task/workflow code in handler modules or definitions modules.
- Search attributes and visibility depend on the Temporal cluster being configured correctly.

## Key Files

- `packages/slingshot-orchestration-temporal/src/index.ts`
- `packages/slingshot-orchestration-temporal/src/adapter.ts`
- `packages/slingshot-orchestration-temporal/src/worker.ts`
- `packages/slingshot-orchestration-temporal/src/workflowModuleGenerator.ts`
