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
