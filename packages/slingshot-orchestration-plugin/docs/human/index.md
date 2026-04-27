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
declare const resolveRequestContext: import('@lastshotlabs/slingshot-orchestration-plugin').OrchestrationRequestContextResolver;

const orchestrationPlugin = createOrchestrationPlugin({
  adapter: createMemoryAdapter({ concurrency: 10 }),
  tasks: [resizeImage, sendWelcomeEmail],
  workflows: [onboardUser],
  routes: true,
  routePrefix: '/orchestration',
  routeMiddleware: [requireAdmin],
  resolveRequestContext,
});
```

## Manifest setup

Manifest mode supports orchestration route hooks too. Tasks and workflows are referenced by exported
handler names, while route hooks are regular handler refs:

```json
{
  "plugins": [
    {
      "plugin": "slingshot-orchestration",
      "config": {
        "adapter": { "type": "memory", "config": { "concurrency": 10 } },
        "tasks": ["resizeImage", "sendWelcomeEmail"],
        "workflows": ["onboardUser"],
        "routes": true,
        "routePrefix": "/orchestration",
        "routeMiddleware": [{ "handler": "requireAdmin" }],
        "resolveRequestContext": { "handler": "resolveOrchestrationRequestContext" },
        "authorizeRun": { "handler": "authorizeOrchestrationRun" }
      }
    }
  ]
}
```

## What this package does not do

- it does not define tasks or workflows
- it does not implement orchestration engines
- it does not make orchestration a first-class `SlingshotContext` property

That separation is intentional. The portable runtime stays reusable outside Slingshot.

## Definition and service wiring

This package registers orchestration definitions and request hooks. It does not provide a service
registry for arbitrary business services.

- Pass `tasks` and `workflows` directly to `createOrchestrationPlugin()` in code-first apps.
- In manifest apps, export those definitions from your handlers module and reference them by name in the orchestration plugin config.
- Use `resolveRequestContext()` and `authorizeRun()` to wire request-scoped identity and access rules without coupling the router to actor-resolution internals.
- Keep domain services such as quoting engines, carrier APIs, pricing rules, and ordering clients in your normal application composition. Inject or import them inside task handlers.

## Route contract

When `routes: true`, `routeMiddleware` must be non-empty. This is a hard configuration error.

Current endpoints:

- `GET /tasks`
- `GET /workflows`
- `POST /tasks/:name/runs`
- `POST /workflows/:name/runs`
- `GET /runs/:id`
- `DELETE /runs/:id`
- `GET /runs`
- `POST /runs/:id/signal/:signalName`

Signal routes return `501` for adapters without signal support.

Create-run requests accept idempotency in either place:

- JSON body: `idempotencyKey`
- HTTP header: `Idempotency-Key`

Accepted create responses include the run identity plus a follow-up link:

- `id`
- `type`
- `name`
- `status`
- `links.run`

List-run query parameters:

- `type=task|workflow`
- `name=<definition-name>`
- `status=pending|running|completed|failed|cancelled|skipped`
- `limit=<1-1000>`
- `offset=<0+>`

When no custom `authorizeRun()` hook is supplied, tenant-scoped callers can see:

- runs for their own `tenantId`
- global runs with no `tenantId`

## Request Context

The orchestration router does not read actor or tenant identity from framework-local context keys.
Pass explicit hooks when you want tenant scoping, actor metadata, or run-level authorization:

```ts
import { OrchestrationError } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationPlugin } from '@lastshotlabs/slingshot-orchestration-plugin';
import type {
  OrchestrationRunAuthorizationInput,
} from '@lastshotlabs/slingshot-orchestration-plugin';
import type { Context } from 'hono';

declare const adapter: import('@lastshotlabs/slingshot-orchestration').OrchestrationAdapter;
declare const tasks: import('@lastshotlabs/slingshot-orchestration').AnyResolvedTask[];
declare const workflows: import('@lastshotlabs/slingshot-orchestration').AnyResolvedWorkflow[];
declare const requireAdmin: import('hono').MiddlewareHandler;

const orchestrationPlugin = createOrchestrationPlugin({
  adapter,
  tasks,
  workflows,
  routes: true,
  routeMiddleware: [requireAdmin],
  resolveRequestContext(c: Context) {
    const tenantId = c.req.header('x-tenant-id');
    if (!tenantId) {
      throw new OrchestrationError('VALIDATION_FAILED', 'missing x-tenant-id');
    }
    return {
      tenantId,
      actorId: c.req.header('x-actor-id') ?? undefined,
      metadata: { source: 'ops-api' },
    };
  },
  authorizeRun({ context, run }: OrchestrationRunAuthorizationInput) {
    return run.tenantId === undefined || run.tenantId === context.tenantId;
  },
});
```

`resolveRequestContext()` controls what request-scoped tenant and actor metadata gets stamped onto
runs. `authorizeRun()` controls read/cancel/signal/list visibility without coupling the router to
any specific auth package or actor model.

`resolveRequestContext()` can also stamp:

- `tags`, which merge into run tags
- `metadata`, which merges into run metadata
- `actorId`, which is written into run metadata automatically

## HTTP examples

Start a task run:

```bash
curl -X POST http://localhost:3000/orchestration/tasks/resize-image/runs \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant-a' \
  -H 'x-actor-id: user-123' \
  -H 'Idempotency-Key: resize:asset_42' \
  -d '{ "input": { "assetId": "asset_42" } }'
```

Typical `202` response:

```json
{
  "id": "run_01ABC...",
  "type": "task",
  "name": "resize-image",
  "status": "pending",
  "links": {
    "run": "/orchestration/runs/run_01ABC..."
  }
}
```

List visible runs:

```bash
curl 'http://localhost:3000/orchestration/runs?status=running&limit=25' \
  -H 'x-tenant-id: tenant-a' \
  -H 'x-actor-id: user-123'
```

## Events

This package also augments `SlingshotEventMap` with orchestration lifecycle events, so plugins can
subscribe with full typing:

```ts
bus.on('orchestration.workflow.completed', async ({ runId, workflow, durationMs }) => {
  console.log('workflow completed', runId, workflow, durationMs);
});
```

## Handlers note

Manifest-driven orchestration registration is supported through exported task/workflow handlers, and
manifest route config can also reference `routeMiddleware`, `resolveRequestContext`, and
`authorizeRun` handlers.
