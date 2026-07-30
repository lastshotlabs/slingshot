# @lastshotlabs/slingshot-events

Install with Bun:

```sh
bun add @lastshotlabs/slingshot-events
```

# Transactional events

`@lastshotlabs/slingshot-events` owns Slingshot's SQL transactional outbox and
consumer inbox. It preserves the governed `EventEnvelope` and adds explicit,
opt-in reliability without changing ordinary synchronous event publication.

Configure `events.reliability` only when an application needs atomic event
persistence:

```ts
defineApp({
  db: { postgres: process.env.DATABASE_URL },
  eventBus: acknowledgedBus,
  events: {
    reliability: {
      store: 'postgres',
      outbox: { enabled: true },
      inbox: { enabled: true },
    },
  },
});
```

PostgreSQL and SQLite are supported as reliability stores. An enabled outbox
requires a bus implementing acknowledged durable publication. Invalid stores,
missing database configuration, in-process buses, and unsafe lease/retry
settings fail during bootstrap before migrations or workers start.

The package does not claim exactly-once delivery. Broker redelivery is expected;
the stable envelope event ID and transactional consumer inbox provide
idempotency for SQL effects. External effects must use that event ID as the
provider idempotency key.

When the outbox is enabled, Slingshot starts a lease-based dispatcher after
migrations complete and stops it before the event bus and SQL connection close.
PostgreSQL claims use `FOR UPDATE SKIP LOCKED`; SQLite permits one dispatcher
per application instance and uses conditional claims. Publication happens
outside the claim transaction. A row becomes `delivered` only when the broker
receipt matches its event ID and reports at least one durable destination.
Failures return to `pending` with bounded exponential backoff, become `dead`
after `maxAttempts`, and abandoned leases are eligible for takeover.

BullMQ acknowledged publication targets the currently registered durable
subscriptions. If none exist, its receipt reports zero destinations and the
outbox keeps the row retryable. Kafka acknowledged publication awaits
`producer.send()` directly. Neither acknowledged path uses the adapters'
legacy in-memory retry buffer, so the SQL outbox remains the single retry
authority.

## Transactional consumers

Use `events.consume()` for durable handlers whose SQL effects must be
idempotent under broker redelivery:

```ts
events.consume(
  'orders:order.created',
  async (envelope, { scope }) => {
    const projections = entities.get(OrderProjection, { scope });
    await projections.upsert({ orderId: envelope.payload.orderId });
  },
  {
    durable: true,
    name: 'orders-projection-v1',
    inbox: { store: 'postgres' },
  },
);
```

The framework inserts `(consumerName, eventId)` before invoking the handler,
inside the same PostgreSQL or SQLite transaction. The first delivery commits
the receipt and handler SQL effects together. A committed duplicate skips the
handler; a thrown handler rolls back both and remains safe for broker retry.
Concurrent duplicates serialize on the inbox primary key.

Consumer names are persistent deployment identities. Renaming a consumer
intentionally creates a new logical consumer and reprocesses retained events.
Only SQL work performed through the supplied scope is covered. HTTP calls,
email, object storage, and other external effects still require
`envelope.meta.eventId` as the provider idempotency key.

## Operations and readiness

The framework adds two event-reliability indicators to `/health/ready`.
Pending age and expired leases are warnings. Dead rows follow
`events.reliability.readiness.deadRows`; the default is critical. Transport
health uses the adapter's cached state, so readiness remains responsive during
a broker outage instead of waiting on a new broker connection.

Metrics use only bounded `store`, `transport`, and `status` labels. They cover
outbox insertion, claims, acknowledgements, retry/dead transitions, publication
latency, inbox duplicates, handler failures, retention, row counts, and expired
leases. Structured dispatcher logs include the event key and only a shortened
event ID.

Use the CLI instead of editing reliability tables:

```sh
slingshot events outbox status
slingshot events outbox list --status dead
slingshot events outbox retry <event-id> --confirm '<exact app name>'
slingshot events outbox retry --all-dead --confirm '<exact app name>'
slingshot events outbox purge --delivered-before 7d --confirm '<exact app name>'
slingshot events inbox purge --before 30d --confirm '<exact app name>'
```

Status and list are read-only. Every mutation requires the exact configured app
name. Replay preserves the stored envelope and event ID and writes an audit
record. Purge operations are bounded; outbox retention can delete only rows
already marked `delivered`, never pending, leased, or dead work.

For an authenticated HTTP surface, enable the operator router alongside
reliability:

```ts
events: {
  registerContracts(events) {
    events.register(orderCreated);
    events.registerVersionAdapter(orderCreatedV1ToV2);
  },
  reliability: {
    store: 'postgres',
    outbox: { enabled: true },
    inbox: { enabled: true },
  },
  operator: { enabled: true },
}
```

Keep event definitions and adapters in this pure `registerContracts` callback
when direct CLI replay is required. App bootstrap and CLI tooling invoke the
same callback and construct the same replay validator; the CLI fails closed
with `validator-unavailable` when it is omitted.

The router is mounted at `/admin/events` by default. Production startup fails
unless an authentication plugin publishes route auth and the permissions
package publishes its evaluator. Grant the `viewer` resource role for
`events:read`, or `operator` for both `events:read` and `events:operate`, on the
`event-operations` resource type.

Inspection returns an allowlisted projection. Payload credentials, cookies,
authorization values, tokens, secrets, passwords, API keys, and private keys
are recursively redacted; the stored envelope is never returned or rewritten.
Replay validates the stored schema version, applies an explicitly registered
ascending adapter chain in memory, and validates the adapted payload before
making the row retryable. A missing adapter, future version, unknown event, or
invalid payload fails closed without mutating the outbox.

Every HTTP mutation requires an authenticated actor and a non-empty reason of
at most 500 characters. Replay and retention mutations write the package-owned
SQL ledger atomically with the mutation and also write the framework audit log.
See `operations/runbook.md` and import
`operations/grafana-event-reliability.json` for the shipped response procedure
and starter dashboard.
