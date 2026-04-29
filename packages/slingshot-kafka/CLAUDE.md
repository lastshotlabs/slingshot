# slingshot-kafka

Kafka-backed Slingshot event bus adapter and programmatic connector bridge. The adapter
replaces the in-process event bus with durable Kafka topics for fan-out that survives
process restarts. The connector bridge adds explicit inbound/outbound Kafka topic
mappings with transforms, validation, DLQ routing, deduplication, and buffered retry.

## Key Files

| File                    | What                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| src/index.ts            | Public API surface: adapter, connectors, topic naming, and types            |
| src/kafkaAdapter.ts     | `createKafkaAdapter()` durable event bus with producer reconnect buffer,    |
|                         | consumer lifecycle, DLQ routing, health snapshots, and metrics              |
| src/kafkaConnectors.ts  | `createKafkaConnectors()` inbound/outbound bridge with dedup store,         |
|                         | transforms, schema validation, and outbound pending buffer                  |
| src/kafkaShared.ts      | Shared SASL, SSL, and compression Zod schemas and backoff helper            |
| src/kafkaTopicNaming.ts | `toTopicName()` and `toGroupId()` stable naming conventions                 |
| docs/human/index.md     | Package guide synced into the docs site                                     |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-core` (`SlingshotEventBus`, `EventEnvelope`, `EventSerializer`, `Logger`, `MetricsEmitter`, `HealthReport`, `HealthState`, `JSON_SERIALIZER`, `withTimeout`, `TimeoutError`, `sanitizeHeaderValue`, `sanitizeLogValue`, `createRawEventEnvelope`, `isEventEnvelope`, `validateEventPayload`, `validatePluginConfig`, `createConsoleLogger`, `createNoopMetricsEmitter`), `kafkajs`, `zod`
- **Imported by**: manifest bootstrap via `../../src/lib/createServerFromManifest.ts` and direct application use

## Common Tasks

- **Adding adapter options**: update the `kafkaAdapterOptionsSchema` in `src/kafkaAdapter.ts`, add defaults to the `DEFAULTS` object, and wire the option into `ResolvedKafkaConfig`
- **Adding a drop reason**: extend `KafkaAdapterDropReason` in `src/kafkaAdapter.ts`, initialize its counter in `dropCounts`, and call `notifyDrop()` at the new site
- **Adding connector options**: update the inbound or outbound schema in `src/kafkaConnectors.ts`, validate in the `start()` preamble, and update `docs/human/index.md`
- **Changing topic naming**: update `src/kafkaTopicNaming.ts`; both adapter and connectors import from this module
- **Testing**: `packages/slingshot-kafka/tests/` (unit tests in `tests/unit/`, integration tests in `tests/integration/`)
