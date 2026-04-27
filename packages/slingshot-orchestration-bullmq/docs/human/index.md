---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-orchestration-bullmq
---

This package provides a BullMQ-backed adapter for `@lastshotlabs/slingshot-orchestration`.

Use it when you want:

- durable task and workflow execution
- Redis-backed queues and retries
- progress updates through BullMQ `QueueEvents`
- repeatable schedules without a separate scheduler service

## What it adds

- `createBullMQOrchestrationAdapter()` as the Redis-backed orchestration provider
- queue-per-task support through `TaskDefinition.queue`
- BullMQ worker processors for tasks and workflows
- scheduling support through BullMQ repeatable jobs

## Current capability profile

- Core execution: yes
- Scheduling: yes
- Observability: yes
- Progress subscriptions: yes
- Signals: no

## Provider boundary

This package depends on the portable orchestration core but not on Slingshot plugin helpers.

Typical composition:

1. Define tasks and workflows in `@lastshotlabs/slingshot-orchestration`
2. Create the BullMQ adapter in this package
3. Pass that adapter into `createOrchestrationRuntime()` or `createOrchestrationPlugin()`

## Minimal setup

```ts
import { createOrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';
import { createBullMQOrchestrationAdapter } from '@lastshotlabs/slingshot-orchestration-bullmq';

declare const tasks: import('@lastshotlabs/slingshot-orchestration').AnyResolvedTask[];
declare const workflows: import('@lastshotlabs/slingshot-orchestration').AnyResolvedWorkflow[];

const adapter = createBullMQOrchestrationAdapter({
  connection: { host: '127.0.0.1', port: 6379 },
  prefix: 'orchestration',
  concurrency: 20,
});

const runtime = createOrchestrationRuntime({
  adapter,
  tasks,
  workflows,
});
```

## When to choose BullMQ

- Choose it when Redis is already operationally standard in the stack.
- Choose it when you need queue-backed orchestration and repeatable schedules, but not Temporal-style signals and workflow history.
- Do not treat it as the strongest audit system of record for active cancellation semantics; it is durable, but some stop behavior is still adapter-managed rather than natively modeled by BullMQ.

Lifecycle notes:

- `createOrchestrationPlugin()` starts and stops the adapter for you
- direct `createOrchestrationRuntime()` usage now lazy-starts the adapter on first use
- step-level retry and timeout overrides are carried into BullMQ child jobs so workflow behavior
  stays aligned with the portable runtime contract
- idempotency keys are scoped by run type, definition name, and tenant to match the portable
  orchestration adapters
- workflow hook failures emit the portable `orchestration.workflow.hookError` event when an
  event sink is configured, and otherwise fall back to `console.error`
- progress subscriptions are safe to register and unregister even while the adapter is still
  lazily starting
- cancelled runs stay visible through `getRun()` and `listRuns()` even when a pending BullMQ job
  had to be removed from the queue to stop execution
- cancelling an active BullMQ job is still best-effort for the underlying worker code; if the
  adapter cannot actually stop the job, the cancel call fails instead of falsely reporting
  `cancelled`, and already-started side effects are not rolled back

## Operational notes

- Prefer explicit queue names on tasks when you need workload isolation by domain, such as quoting, binding, document generation, or downstream carrier synchronization.
- Keep Redis persistence and retention settings aligned with how long you expect run observability data to remain useful.
- If you need strong human-in-the-loop signaling or workflow query semantics, move to the Temporal provider instead of layering those expectations onto BullMQ.
