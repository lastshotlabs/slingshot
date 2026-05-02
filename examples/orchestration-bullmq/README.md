# Orchestration (BullMQ) Example

Source-backed example showing how to wire `slingshot-orchestration-bullmq`
into the orchestration plugin. This is the production-shaped variant of
`examples/orchestration/`, which uses the in-memory adapter.

## What it shows

- `createBullMQOrchestrationAdapter()` constructed with a real ioredis-shaped
  `connection` config
- `requireTls: true` — the adapter throws synchronously at startup if no TLS
  options were provided. Use this in production to refuse plaintext Redis
  connections by accident.
- `concurrency`, `shutdownDrainTimeoutMs`, and `jobRetention` defaults that
  keep Redis memory bounded as completed/failed jobs age out
- a single one-step workflow (`onboard-customer`) that fans out to a
  `send-email` task

## Files

- `app.config.ts` - typed app config with the BullMQ adapter

## Prerequisites

Redis must be reachable. For local development:

```bash
docker run --rm -p 6379:6379 redis:7
```

For production behind TLS (ElastiCache, Upstash, MemoryStore), pass a real
TLS block:

```typescript
connection: {
  host: process.env.REDIS_HOST,
  port: 6379,
  tls: {
    rejectUnauthorized: true,
    ca: process.env.REDIS_CA,
  },
},
requireTls: true,
```

## Run

From the repo root:

```bash
JWT_SECRET=dev-secret-change-me-dev-secret-change-me \
REDIS_HOST=127.0.0.1 \
slingshot start --config examples/orchestration-bullmq/app.config.ts
```

Start a workflow run:

```bash
curl -X POST http://localhost:3000/orchestration/workflows/onboard-customer/runs \
  -H 'content-type: application/json' \
  -H 'x-ops-key: dev-ops-key' \
  -H 'x-tenant-id: tenant-acme' \
  -H 'x-actor-id: ops@example.com' \
  -d '{ "input": { "email": "newcomer@example.com" } }'
```

The BullMQ workers running inside the same process pick up the job, execute
the task, and update the run state. Inspect the run via:

```bash
curl http://localhost:3000/orchestration/runs/<run-id> \
  -H 'x-ops-key: dev-ops-key' \
  -H 'x-tenant-id: tenant-acme'
```

## Job retention

Without `jobRetention` defaults, Redis memory grows unbounded as completed
and failed jobs accumulate. The example sets:

- `removeOnCompleteAge: 3600` — drop completed jobs after 1 hour
- `removeOnCompleteCount: 1000` — keep at most 1000 completed jobs per queue
- `removeOnFailAge: 86400` — keep failed jobs for 24 hours so they can be
  inspected before being purged

## Manifest mode

When using the manifest, the plugin resolves `adapter.type: "bullmq"` to
`createBullMQOrchestrationAdapter()` and forwards `adapter.config` verbatim.
Tasks and workflows must be registered through the manifest handler registry
under the names referenced in the manifest (`sendEmail`,
`onboardCustomerWorkflow`).
