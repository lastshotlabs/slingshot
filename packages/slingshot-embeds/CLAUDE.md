# slingshot-embeds

URL unfurling plugin for Slingshot. It fetches remote HTML server-side, extracts Open Graph
metadata, and returns normalized preview data.

## Key Files

| File                  | What                                                    |
| --------------------- | ------------------------------------------------------- |
| src/index.ts          | Public API surface for plugin, unfurl helper, and types |
| src/plugin.ts         | `createEmbedsPlugin()` factory                          |
| src/types.ts          | Embed result and plugin config types                    |
| src/lib/unfurl.ts     | End-to-end unfurl pipeline                              |
| src/lib/htmlParser.ts | HTML and Open Graph metadata parsing                    |
| src/lib/ssrfGuard.ts  | URL validation and SSRF protection                      |
| docs/human/index.md   | Package guide synced into the docs site                 |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Changing preview extraction**: update `src/lib/htmlParser.ts` and keep the return types in `src/types.ts` aligned
- **Changing fetch safety rules**: update `src/lib/ssrfGuard.ts`, then update `docs/human/index.md`
- **Changing plugin options**: update `src/types.ts` and `src/plugin.ts`
