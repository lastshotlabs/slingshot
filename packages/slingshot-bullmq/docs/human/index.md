---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-bullmq
---

`@lastshotlabs/slingshot-bullmq` is the durable BullMQ-backed event bus adapter for Slingshot.
Use it when the default in-process event bus is not enough and event fan-out must survive process
restarts.

## What It Provides

- `createBullMQAdapter()` — a `SlingshotEventBus` implementation backed by BullMQ queues
- Per-event queues in Redis, one BullMQ `Queue` and `Worker` per subscribed event key
- Durable subscriptions that survive process restart via `offEnvelope`/`onEnvelope`
- In-memory buffer for events that failed to enqueue, with configurable retry and drop-after-limit
- Event payload validation modes (`strict`, `warn`, `off`)

## Minimum Setup

```ts
import { createBullMQAdapter } from '@lastshotlabs/slingshot-bullmq';

const bus = createBullMQAdapter({
  connection: { host: 'localhost', port: 6379 },
});
```

Pass it to `createServer()` or `createApp()` as the `bus` option.

## Operational Notes

- `connection.port` must be a **number**, not a string. Env-var values need explicit coercion:
  `port: Number(process.env.REDIS_PORT)`.
- Each event key gets its own queue. Naming is deterministic: colons are replaced with
  underscores so BullMQ's Redis key separator is not ambiguous.
- Durable subscriptions are registered with BullMQ `Worker`. Workers are created lazily — the
  first `onEnvelope` call for a given event key creates the worker for that queue.
- The in-memory pending buffer retries failed enqueues up to `MAX_ENQUEUE_ATTEMPTS`. Events
  that exhaust retries are dropped and logged. This buffer is process-local and not durable
  across restarts.
- `validation: 'strict'` rejects events whose payload does not match the registered schema.
  `'warn'` logs a warning but delivers anyway. `'off'` (default) skips validation entirely.

## Gotchas

- The adapter does not manage Redis connection lifecycle. You are responsible for Redis
  availability. If Redis is unavailable at subscribe time, events will buffer in memory.
- `queue.add()` is bounded by `enqueueTimeoutMs` (default 10 000 ms). If Redis does not
  accept the job within that window the call rejects, preventing hung queue workers.
- Workers are not stopped until the process exits or `offEnvelope` is called. Unsubscribing
  all handlers for an event key closes the worker for that queue.
- `prefix` defaults to `"slingshot:events"`. If you run multiple Slingshot apps against the
  same Redis instance, set a distinct prefix per app to avoid cross-app event delivery.

## Key Files

- `src/bullmqAdapter.ts`
- `src/index.ts`
