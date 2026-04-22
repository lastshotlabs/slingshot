# Orchestration Example

Code-first orchestration example for Slingshot.

What it demonstrates:

- `defineTask()` and `defineWorkflow()` authoring
- `createOrchestrationPlugin()` with protected HTTP routes
- runtime lookup with `getOrchestration()`
- app-owned routes that start workflows directly
- in-memory adapter setup that can later be swapped to SQLite or BullMQ

The example does not hardcode tenant or actor scope into framework context. Protected orchestration
routes use an explicit request-context resolver and expect:

- `x-ops-key: dev-ops-key`
- `x-tenant-id: <tenant>`
- `x-actor-id: <actor>` (optional, defaults to `ops-automation`)
- `Idempotency-Key: <key>` (optional, recommended for create calls)

Useful endpoints:

- `GET /orchestration/tasks`
- `GET /orchestration/workflows`
- `POST /orchestration/tasks/:name/runs`
- `POST /orchestration/workflows/:name/runs`
- `GET /orchestration/runs/:id`

Run the example:

```bash
bun run examples/orchestration/src/index.ts
```

Start a workflow:

```bash
curl -X POST http://localhost:3000/orchestration/workflows/process-invoice/runs \
  -H 'content-type: application/json' \
  -H 'x-ops-key: dev-ops-key' \
  -H 'x-tenant-id: tenant-acme' \
  -H 'x-actor-id: billing-admin-42' \
  -H 'Idempotency-Key: invoice:inv_123' \
  -d '{
    "input": {
      "invoiceId": "inv_123",
      "customerEmail": "ops@example.com",
      "amountCents": 12500
    }
  }'
```

Inspect the run:

```bash
curl http://localhost:3000/orchestration/runs/<run-id> \
  -H 'x-ops-key: dev-ops-key' \
  -H 'x-tenant-id: tenant-acme' \
  -H 'x-actor-id: billing-admin-42'
```

List active tenant-visible runs:

```bash
curl 'http://localhost:3000/orchestration/runs?status=running&limit=25' \
  -H 'x-ops-key: dev-ops-key' \
  -H 'x-tenant-id: tenant-acme' \
  -H 'x-actor-id: billing-admin-42'
```
