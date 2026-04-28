---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-kafka
---

> Human-owned documentation. This page is the package-level contract for Kafka transport behavior, operator expectations, and production guidance.

## Purpose

`@lastshotlabs/slingshot-kafka` provides two Kafka integration surfaces for Slingshot:

- `createKafkaAdapter(...)` for using Kafka as the internal event bus
- `createKafkaConnectors(...)` for bridging between the internal event bus and external Kafka topics

This package owns Kafka transport concerns only. It does not provision brokers, topics outside its auto-create paths, ACLs, or cluster infrastructure.

## Supported Connection Modes

- SASL mechanisms:
  - `plain`
  - `scram-sha-256`
  - `scram-sha-512`
- TLS modes:
  - `ssl: true` for platform trust store / ambient CA trust
  - `ssl: { ca }` for explicit broker trust
  - `ssl: { ca, cert, key }` for mTLS / client-certificate auth

These modes are live-verified in Docker against Redpanda listeners, including negative paths for:

- bad SASL credentials
- wrong CA bundle
- mTLS listener access without a client certificate

## Package Boundaries

- Kafka serialization, topic naming, durable-consumer wiring, retries, and DLQ handoff belong here.
- Event schema validation contracts come from `@lastshotlabs/slingshot-core`.
- Manifest assembly, secrets resolution, and framework startup belong in `@lastshotlabs/slingshot`.
- Broker lifecycle, ACL policy, topic retention, partition count strategy, and cluster sizing belong to the broker provider or platform team.

## Production Guidance

- Prefer TLS for every non-local environment.
- Treat `ssl.rejectUnauthorized: false` as local-development-only. The runtime warns because it disables broker certificate verification.
- Prefer provisioned topics over `autoCreateTopics` / `autoCreateTopic` in production.
- If you must auto-create topics, do not leave replication factor at `1` outside disposable environments. The runtime warns on that path.
- If using SASL, pair it with TLS unless the broker is on a fully trusted isolated network segment and that exception is deliberate.
- For mTLS, provide PEM strings through programmatic config or manifest `ssl` objects. The built-in secret bundle only supports the coarse `KAFKA_SSL=true` switch, not PEM material injection.

## Manifest And Secrets Behavior

- `eventBus: 'kafka'` or `eventBus: { type: 'kafka', config }` resolves the built-in Kafka adapter through the framework.
- `eventBus.config.brokers` is accepted and can be used without `KAFKA_BROKERS`.
- `kafkaConnectors.brokers` is accepted directly in the manifest. If omitted, the framework falls back to `KAFKA_BROKERS`.
- Secret-driven TLS bootstrap currently supports:
  - `KAFKA_SSL=true`
- Advanced TLS and mTLS bootstrap currently require manifest or programmatic config:
  - `ssl.ca`
  - `ssl.cert`
  - `ssl.key`
  - `ssl.rejectUnauthorized`

## Broker / Provider Requirements

The broker or managed Kafka provider must supply:

- reachable broker endpoints
- the auth mode the client is configured for
- the correct CA chain when TLS is enabled
- a client certificate policy, if mTLS is required
- ACLs for the topics, groups, and create/read/write operations the app needs

This package assumes the provider owns:

- retention and compaction policy
- replication and ISR policy
- cluster quotas and throughput limits
- topic pre-provisioning, unless you intentionally enable auto-create
- certificate issuance and rotation outside local test fixtures

## Operational Runbook

### Startup checklist

- Confirm brokers resolve from the running process.
- Confirm the configured SASL mode matches the broker listener.
- Confirm the CA bundle is the one that signed the broker certificate.
- For mTLS, confirm the client cert and key are both present and signed by a CA the broker trusts.
- Confirm ACLs allow topic metadata, produce, consume, and group membership for the configured topics/groups.

### Failure triage

- `SASL authentication failed`
  - Check username, password, and mechanism.
  - Confirm the broker listener actually enables that SASL mechanism.
- certificate / TLS verification failures
  - Check `ssl.ca`, certificate chain, hostname/SAN, and whether `rejectUnauthorized` is being forced.
- auth succeeds but produce/consume fails
  - Check topic and group ACLs.
  - Check whether the broker allows topic auto-creation for that principal.
- durable consumer never reaches connected state
  - Check group ACLs, topic existence, listener reachability, and partition assignment.
- repeated buffering / drain failures
  - Check broker availability, ACLs, and whether the producer can reconnect after transient disconnects.

### Observability hooks

- `createKafkaAdapter(...).health()` exposes producer/admin/consumer connectivity and pending buffer size.
- `createKafkaConnectors(...).health()` exposes inbound/outbound runtime state and pending buffer size.
- `createKafkaConnectors(...).hooks` can be used to wire package-level metrics or structured logs for inbound success/error, outbound success/error, suppression, and DLQ writes.

## Gotchas

- SASL authentication and authorization are different. A principal can authenticate successfully and still fail topic or group operations without ACLs.
- `ssl: true` depends on the process trust store. For private CAs, prefer `ssl: { ca }`.
- Manifest secret resolution does not currently ingest PEM blobs for Kafka TLS. Use manifest or programmatic `ssl` objects for advanced TLS and mTLS.
- This workspace applies a temporary local KafkaJS patch during install to avoid `TimeoutNegativeWarning` under Bun. Remove that patch when upstream KafkaJS ships the fix we are pinned waiting for.

## Production Timeouts

Every external Kafka call goes through a bounded `withTimeout` wrapper from
`@lastshotlabs/slingshot-core` so no single hung broker can stall the
adapter forever.

| Option | Default | Bound |
|---|---|---|
| `producerTimeoutMs` | 30_000 | `producer.send()` (durable emits and DLQ produces) |
| `connectTimeoutMs` | 30_000 | `producer.connect()`, `admin.connect()`, `consumer.connect()` |
| `deserializeTimeoutMs` | 5_000 | custom `serializer.deserialize()` per message |
| `handlerTimeoutMs` | 60_000 | per in-flight handler during a rebalance quiesce |

Timeouts surface through `onDrop` with structured reasons:
`producer-timeout`, `deserialize-timeout`, `handler-timeout`. Producer
timeouts buffer the event for retry; deserialize and handler timeouts
abandon the work so the consumer can keep heartbeating.

## DLQ Failure Semantics

When a handler exhausts retries, the adapter forwards the original
message to `${topic}.dlq`. If the DLQ produce fails, two policies are
available:

- `onDlqFailure: 'redeliver'` (default) — do NOT commit the offset. The
  broker redelivers the message after restart; operators see the
  `dlq-production-failed` drop signal and can investigate before
  redrive.
- `onDlqFailure: 'commit-and-log'` — legacy behaviour. Commit anyway,
  accepting the lost message in exchange for forward progress.

## Outbound Message Identifiers

When an outbound `OutboundConnectorConfig.messageId` extractor is unset
and `envelope.meta.eventId` is empty, the connector uses one of three
fallback strategies (`KafkaConnectorsConfig.onIdMissing`):

- `'fingerprint'` (default) — `sha256:` of the serialized payload bytes.
  Stable across retries, dedupable across replicas.
- `'random'` — `randomUUID()`. Logs a warning so operators see that
  consumer-side dedup is effectively off for that event.
- `'reject'` — throw. Useful when callers require strict provenance and
  would rather fail produce than emit a non-deduplicable id.

## Health

`createKafkaAdapter()` implements the `HealthCheck` contract from
`@lastshotlabs/slingshot-core`:

- `getHealth()` returns a `HealthReport` with a coarse `state`
  (`'healthy' | 'degraded' | 'unhealthy'`) and aggregated counters in
  `details`. Suitable for framework-level health aggregation.
- `getHealthSnapshot()` returns the structured `KafkaAdapterHealthSnapshot`
  for callers that need the raw consumer/buffer/drop counters.

## Integration Tests

Set `KAFKA_BROKERS` to enable the live-broker suite at
`tests/integration/kafka.test.ts`:

```sh
KAFKA_BROKERS=localhost:9092 bun test packages/slingshot-kafka/tests/integration
```

Optional environment:

- `KAFKA_SSL=true` enables TLS with the platform trust store.
- `KAFKA_SASL_USER` / `KAFKA_SASL_PASS` enables SASL/PLAIN.

When unset, the suite is silently skipped — the default `bun test` run
uses a fake kafkajs module and stays fast.

## Key Files

- `packages/slingshot-kafka/src/kafkaAdapter.ts`
- `packages/slingshot-kafka/src/kafkaConnectors.ts`
- `src/lib/createServerFromManifest.ts`
- `tests/integration/kafka.test.ts`
- `tests/docker/kafka-sasl.test.ts`
- `tests/docker/kafka-tls.test.ts`
