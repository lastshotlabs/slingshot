---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-orchestration-plugin
---

This package integrates the portable orchestration runtime into the Slingshot plugin model.

It owns:

- `createOrchestrationPlugin()` for plugin lifecycle wiring
- `getOrchestration()` and `getOrchestrationOrNull()` for runtime lookup via `ctx.pluginState`
- `createSlingshotEventSink()` for event bus bridging
- optional HTTP routes under `/orchestration`

## What this package does

- builds or accepts an `OrchestrationRuntime`
- publishes that runtime under the `slingshot-orchestration` plugin-state key
- mounts orchestration HTTP endpoints when enabled
- enforces route middleware when routes are enabled
- starts and stops the concrete adapter when the plugin owns adapter lifecycle

## Basic setup

```ts
import { createMemoryAdapter } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationPlugin } from '@lastshotlabs/slingshot-orchestration-plugin';

declare const resizeImage: import('@lastshotlabs/slingshot-orchestration').AnyResolvedTask;
declare const sendWelcomeEmail: import('@lastshotlabs/slingshot-orchestration').AnyResolvedTask;
declare const onboardUser: import('@lastshotlabs/slingshot-orchestration').AnyResolvedWorkflow;
declare const requireAdmin: import('hono').MiddlewareHandler;

const orchestrationPlugin = createOrchestrationPlugin({
  adapter: createMemoryAdapter({ concurrency: 10 }),
  tasks: [resizeImage, sendWelcomeEmail],
  workflows: [onboardUser],
  routes: true,
  routePrefix: '/orchestration',
  routeMiddleware: [requireAdmin],
});
```

## What this package does not do

- it does not define tasks or workflows
- it does not implement orchestration engines
- it does not make orchestration a first-class `SlingshotContext` property

That separation is intentional. The portable runtime stays reusable outside Slingshot.

## Route contract

When `routes: true`, `routeMiddleware` must be non-empty. This is a hard configuration error.

Current endpoints:

- `POST /tasks/:name/runs`
- `POST /workflows/:name/runs`
- `GET /runs/:id`
- `DELETE /runs/:id`
- `GET /runs`
- `POST /runs/:id/signal/:signalName`

Signal routes return `501` for adapters without signal support.

## Events

This package also augments `SlingshotEventMap` with orchestration lifecycle events, so plugins can
subscribe with full typing:

```ts
bus.on('orchestration.workflow.completed', async ({ runId, workflow, durationMs }) => {
  console.log('workflow completed', runId, workflow, durationMs);
});
```

## Handlers note

Manifest-driven handler export resolution for orchestration is planned work, not current behavior.
Today the package is code-first: you pass tasks, workflows, and route middleware directly.
