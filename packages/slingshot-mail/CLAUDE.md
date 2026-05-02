# slingshot-mail

Transactional mail plugin with provider drivers, queue backends, subject resolution, and
renderer integrations for Slingshot applications.

## Key Files

| File                        | What                                                            |
| --------------------------- | --------------------------------------------------------------- |
| src/index.ts                | Public API surface for plugin, providers, queues, and renderers |
| src/plugin.ts               | `createMailPlugin()` factory                                    |
| src/types/config.ts         | Mail plugin config schema and config types                      |
| src/types/provider.ts       | Provider contract types                                         |
| src/providers/resend.ts     | Representative mail provider implementation                     |
| src/queues/bullmq.ts        | BullMQ-backed delivery queue                                    |
| src/renderers/reactEmail.ts | React Email renderer integration                                |
| docs/human/index.md         | Package guide synced into the docs site                         |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Adding a provider**: add the provider under `src/providers/`, export it from `src/index.ts`, and document the config in `docs/human/index.md`
- **Changing config or queue behavior**: update `src/types/config.ts` and the relevant queue file under `src/queues/`
- **Testing**: `packages/slingshot-mail/tests/`
