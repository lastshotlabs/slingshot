# slingshot-webhooks

Inbound and outbound webhook plugin with entity-backed endpoints, signature helpers, and
queue-backed delivery for retries and fan-out.
Webhook entities follow the shared package-first/entity model; `createWebhookPlugin()` is the runtime
shell that composes delivery and intake wiring.

## Key Files

| File                    | What                                                     |
| ----------------------- | -------------------------------------------------------- |
| src/index.ts            | Public API surface for plugin, queues, and webhook types |
| src/plugin.ts           | `createWebhookPlugin()` factory                          |
| src/types/config.ts     | Webhook plugin config schema                             |
| src/routes/index.ts     | Webhook route surface                                    |
| src/queues/memory.ts    | In-memory webhook queue                                  |
| src/queues/bullmq.ts    | BullMQ-backed webhook queue                              |
| src/manifest/runtime.ts | Manifest-aware runtime helpers                           |
| docs/human/index.md     | Package guide synced into the docs site                  |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Adding or changing delivery backends**: update files under `src/queues/`, then confirm `src/plugin.ts` still resolves them correctly
- **Changing config options**: update `src/types/config.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-webhooks/tests/`
