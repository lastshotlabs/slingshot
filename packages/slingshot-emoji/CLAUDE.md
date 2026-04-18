# slingshot-emoji

Custom emoji management plugin with entity-backed metadata, shortcode validation, and upload
integration for the underlying image assets.

## Key Files

| File                | What                                                     |
| ------------------- | -------------------------------------------------------- |
| src/index.ts        | Public API surface for plugin, manifest, and emoji types |
| src/plugin.ts       | `createEmojiPlugin()` factory                            |
| src/emoji.ts        | Emoji manifest and entity-level wiring                   |
| src/types.ts        | Emoji config and record types                            |
| docs/human/index.md | Package guide synced into the docs site                  |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` and app-level plugin composition

## Common Tasks

- **Changing emoji model behavior**: update `src/emoji.ts`, then verify the plugin contract in `src/plugin.ts`
- **Changing config or public types**: update `src/types.ts` and `src/index.ts`, then update `docs/human/index.md`
- **Updating docs**: search `packages/docs/src/content/docs/` for emoji references when behavior changes
