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

## Durability And The Optional WAL

The in-memory pending buffer bridges short Redis outages within a single
process. It is **lost on crash** unless you opt in to the JSON-lines
write-ahead log via `walPath`.

```ts
const bus = createBullMQAdapter({
  connection: { host, port },
  walPath: '/var/lib/slingshot/bullmq.wal',
  walCompactThreshold: 1024,
});
```

When `walPath` is set:

- every entry pushed onto the pending buffer is appended to the file as a
  JSON line (`{"op":"append",...}`) before being held in memory;
- successful drains append a tombstone (`{"op":"consume",...}`); and
- on adapter creation the file is replayed and any still-live entries are
  loaded back into the pending buffer.

The file grows append-only between compactions. When the live entry count
exceeds `walCompactThreshold` (default 1024) the adapter rewrites the file
with only the still-live records.

## Health

The adapter implements `HealthCheck` from `@lastshotlabs/slingshot-core`.

- `getHealth()` is synchronous and returns the last cached `HealthReport`.
  No I/O. `failedJobsCount` reports `'unknown'` until at least one
  `checkHealth()` probe has run.
- `checkHealth()` runs a live probe — pings the configured queues with
  `getJobCounts('failed')` and refreshes the cached snapshot.

The structured `BullMQAdapterHealth` (queue/worker counts, pending buffer
size, drop counters, etc.) is available via `getHealthDetails()` and
`checkHealthDetails()` for callers that need the raw fields.

## Integration Tests

Set `REDIS_URL` to enable the live-broker suite at
`tests/integration/redis.test.ts`:

```sh
REDIS_URL=redis://localhost:6379 bun test packages/slingshot-bullmq/tests/integration
```

When unset, the suite is silently skipped — the default `bun test` run uses
a fake BullMQ module and stays fast.

## Key Files

- `src/bullmqAdapter.ts`
- `src/index.ts`
- `tests/integration/redis.test.ts`
