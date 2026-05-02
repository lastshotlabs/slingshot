# slingshot-image

On-the-fly image optimization plugin. It handles transform options, caching, and route
mounting for snapshot-style image delivery.

## Key Files

| File                 | What                                                          |
| -------------------- | ------------------------------------------------------------- |
| src/index.ts         | Public API surface for plugin, cache helpers, and image types |
| src/plugin.ts        | `createImagePlugin()` factory                                 |
| src/config.schema.ts | Image plugin config schema                                    |
| src/transform.ts     | Image transform pipeline                                      |
| src/routes.ts        | HTTP route wiring for image requests                          |
| src/cache.ts         | Cache adapter helpers                                         |
| docs/human/index.md  | Package guide synced into the docs site                       |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Changing transform options**: update `src/config.schema.ts` and `src/transform.ts` together
- **Changing runtime route behavior**: update `src/routes.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-image/tests/`
