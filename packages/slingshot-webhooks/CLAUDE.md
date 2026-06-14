# slingshot-webhooks

Inbound and outbound webhook **package** with entity-backed endpoints + deliveries,
signing helpers, queue-backed retries, and provider-driven intake. Authored via
`definePackage(...)` and consumed through
`createApp({ packages: [createWebhooksPackage(...)] })`. Cross-package consumers
resolve the unified runtime adapter via `WebhooksAdapterCap`.

## Key Files

| File                            | What                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| src/index.ts                    | Public API surface for package, entities, queues, adapters, and signing helpers    |
| src/plugin.ts                   | `createWebhooksPackage()` factory (`SlingshotPackageDefinition`)                   |
| src/entities/modules.ts         | `buildWebhookEntityModules(...)` — entity modules with manual adapter wiring       |
| src/entities/runtime.ts         | Lifted adapter transforms, secret cipher, governed runtime adapter, delivery state |
| src/entities/webhookEndpoint.ts | WebhookEndpoint entity definition                                                  |
| src/entities/webhookDelivery.ts | WebhookDelivery entity definition + operations                                     |
| src/types/config.ts             | Webhook package config schema and public types                                     |
| src/routes/index.ts             | Webhook route identifier constants                                                 |
| src/routes/inbound.ts           | Provider-driven inbound webhook receiver router                                    |
| src/queues/memory.ts            | In-memory webhook delivery queue                                                   |
| src/queues/bullmq.ts            | BullMQ-backed webhook queue                                                        |
| docs/human/index.md             | Package guide synced into the docs site                                            |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Runtime dependencies**: requires the `slingshot-auth` plugin when entity-backed CRUD routes are enabled (i.e. no `config.adapter`)
- **Imported by**: direct application use

## Common Tasks

- **Adding or changing delivery backends**: update files under `src/queues/`, then confirm `src/plugin.ts` still resolves them correctly
- **Changing adapter transform or governance behavior**: update `src/entities/runtime.ts`, then verify the wiring in `src/entities/modules.ts`
- **Changing config options**: update `src/types/config.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-webhooks/tests/`
