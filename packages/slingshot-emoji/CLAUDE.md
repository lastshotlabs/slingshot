# slingshot-emoji

Custom emoji management **package** with entity-backed metadata, shortcode validation, and
upload integration for the underlying image assets. Authored via `definePackage(...)` and
consumed through `createApp({ packages: [...] })`.

## Key Files

| File                             | What                                                 |
| -------------------------------- | ---------------------------------------------------- |
| src/index.ts                     | Public API surface for package, entity, and types    |
| src/plugin.ts                    | `createEmojiPackage()` factory                       |
| src/entities/emoji.ts            | `EmojiEntity` definition + `emojiModule` entity wrap |
| src/middleware/shortcodeGuard.ts | Shortcode format validation middleware               |
| src/types.ts                     | Emoji config and record types                        |
| docs/human/index.md              | Package guide synced into the docs site              |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: app-level package composition (`createApp({ packages: [createEmojiPackage(...)] })`)

## Common Tasks

- **Changing emoji model behavior**: update `src/entities/emoji.ts`, then verify the package wiring in `src/plugin.ts`
- **Changing config or public types**: update `src/types.ts` and `src/index.ts`, then update `docs/human/index.md`
- **Updating docs**: search `packages/docs/src/content/docs/` for emoji references when behavior changes
