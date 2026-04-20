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

## Contract notes

- task retry policies and task-level concurrency are validated when you call `defineTask()`
- step retry and timeout overrides are validated when you call `step()`
- dynamic `sleep()` durations are validated at workflow execution time, so invalid mapper output
  fails the run consistently across adapters instead of silently turning into an immediate timer
