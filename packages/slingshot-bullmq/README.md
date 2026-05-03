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

### Redis Connection

The `connection` object is passed directly to BullMQ's `Ioredis` constructor. Supported fields
include `host`, `port`, `password`, `db` (database index), `tls`, and `maxRetriesPerRequest`.
For production, prefer a connection string or env-var-based config:

```ts
const bus = createBullMQAdapter({
  connection: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  },
});
```

Redis connection lifecycle (reconnect, backoff, health checks) is managed by ioredis, not by
this adapter. The adapter does not validate the connection at construction time — Redis failures
surface on the first enqueue or subscribe call.

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

### WAL Durability

This adapter delegates durability to Redis, not SQLite. There is no Write-Ahead Log (WAL)
involved — BullMQ jobs persist through Redis's AOF (Append-Only File) and RDB snapshot
mechanisms. For production deployments:

- Enable AOF persistence (`appendonly yes`) in your Redis config to survive process crashes
  with minimal data loss.
- Configure `save` directives for periodic RDB snapshots as a fallback.
- The adapter's pending in-memory buffer is **not durable** — events held in the buffer
  (because Redis was unreachable) are lost on process restart.

Conceptually, Redis AOF serves the same role as SQLite WAL: it is a write-ahead log that
survives crashes. The difference is that SQLite WAL is a file-local journal, while Redis AOF
is a network-accessible append log replicated to disk by the Redis server.

### Health Reporting

The adapter exposes two health methods:

- `getHealth()` — synchronous, returns the last-cached health snapshot
- `checkHealth()` — live probe that performs a Redis `PING` and refreshes queue/worker counts

Both return a `BullMQAdapterHealth` object:

```ts
interface BullMQAdapterHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  queueCount: number;
  workerCount: number;
  pendingEventCount: number;
  bufferDroppedCount: number;
}
```

`status` rolls up as:
- `'unhealthy'` when events have been dropped from the pending buffer (`bufferDroppedCount > 0`)
- `'degraded'` when the pending buffer is non-empty (Redis was recently unreachable)
- `'healthy'` otherwise

```ts
const bus = createBullMQAdapter({ connection: { host: 'localhost', port: 6379 } });
await bus.checkHealth();
// { status: 'healthy', queueCount: 0, workerCount: 0, pendingEventCount: 0, bufferDroppedCount: 0 }
```

Call `checkHealth()` from your framework health endpoint to verify the bus is operational.
Use `getHealth()` for in-path checks that must not perform I/O.

## Gotchas

- The adapter does not manage Redis connection lifecycle. You are responsible for Redis
  availability. If Redis is unavailable at subscribe time, events will buffer in memory.
- `queue.add()` is bounded by `enqueueTimeoutMs` (default 10 000 ms). If Redis does not
  accept the job within that window the call rejects, preventing hung queue workers.
- Workers are not stopped until the process exits or `offEnvelope` is called. Unsubscribing
  all handlers for an event key closes the worker for that queue.
- `prefix` defaults to `"slingshot:events"`. If you run multiple Slingshot apps against the
  same Redis instance, set a distinct prefix per app to avoid cross-app event delivery.
- **Durable subscriptions:** subscriptions registered via `onEnvelope` survive process
  restarts only because BullMQ queues are Redis-backed. The subscription *binding* (which
  event keys to subscribe to) must be re-registered on each startup — it is not persisted
  to Redis. Always call `onEnvelope` during app initialization, not conditionally at runtime.
- **Shutdown behavior:** call `offEnvelope` for each subscribed key during graceful shutdown
  to close the underlying BullMQ worker. Without this, the worker continues polling Redis
  and processing jobs even after the app has stopped listening for HTTP requests. The adapter
  does not auto-clean workers on process exit — unclosed workers delay process termination
  until ioredis's `maxRetriesPerRequest` budget is exhausted.

## Key Files

- `src/bullmqAdapter.ts`
- `src/index.ts`
