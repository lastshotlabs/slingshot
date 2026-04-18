# slingshot-ssg

Static site generation helpers built on top of Slingshot SSR. This package crawls SSR routes and
renders them into static output.

## Key Files

| File                | What                                            |
| ------------------- | ----------------------------------------------- |
| src/index.ts        | Public API surface for crawl and render helpers |
| src/crawler.ts      | Route crawling for SSG                          |
| src/renderer.ts     | Static page rendering pipeline                  |
| src/types.ts        | SSG config and result types                     |
| src/cli.ts          | CLI entry point                                 |
| docs/human/index.md | Package guide synced into the docs site         |

## Connections

- **Imports from**: `packages/slingshot-ssr/src/index.ts`
- **Imported by**: direct application and CLI use; no workspace package has a static dependency on it

## Common Tasks

- **Changing crawl behavior**: update `src/crawler.ts`, then trace the impact through `src/renderer.ts`
- **Changing output contracts**: update `src/types.ts` and `src/index.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-ssg/tests/`
