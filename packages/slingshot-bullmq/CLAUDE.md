# slingshot-bullmq

Durable BullMQ-backed event bus adapter. Use this package when in-process delivery is not
enough and event fan-out must survive process restarts.

## Key Files

| File                                                         | What                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| src/index.ts                                                 | Public API surface for the BullMQ adapter                |
| src/bullmqAdapter.ts                                         | `createBullMQAdapter()` implementation and option schema |
| docs/human/index.md                                          | Package guide synced into the docs site                  |
| packages/docs/src/content/docs/examples/custom-event-bus.mdx | User-facing example that demonstrates this adapter       |

## Connections

- **Imports from**: `packages/slingshot-core/src/eventBus.ts`
- **Imported by**: no static workspace package dependency; consumers and examples wire it directly

## Common Tasks

- **Changing adapter behavior**: update `src/bullmqAdapter.ts` and keep its JSDoc examples accurate
- **Changing adapter options**: update the schema and exported types in `src/bullmqAdapter.ts`, then update `docs/human/index.md`
- **Updating examples**: keep `packages/docs/src/content/docs/examples/custom-event-bus.mdx` aligned with the current API
