# docs

Astro + Starlight documentation site for Slingshot. This package also owns the workspace doc
sync pipeline and the API reference generator.

## Key Files

| File                                            | What                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| generate-api.ts                                 | API reference generator                                      |
| sync-workspace-docs.ts                          | Syncs package doc lanes into the Astro content tree          |
| workspacePackages.ts                            | Workspace package discovery used by docs tooling             |
| astro.config.mjs                                | Starlight site config and sidebar structure                  |
| src/content/docs/start-here.mdx                 | Top-level routing page for contributor vs app-builder flows  |
| src/content/docs/agent-flows/\*.mdx             | Explicit framework-contributor and app-builder workflows     |
| src/content.config.ts                           | Astro content collection definitions                         |
| src/content/docs/guides/security.mdx            | Voice and structure reference for user-facing guides         |
| src/content/docs/authoring/plugin-interface.mdx | Authoring guide that must stay aligned with plugin contracts |

## Connections

- **Imports from**: every workspace package through `workspacePackages.ts` and package-local guides such as `packages/slingshot-auth/docs/human/index.md`
- **Imported by**: doc build scripts and local docs commands from the repo root

## Common Tasks

- **Adding or fixing hand-written docs**: edit files under `src/content/docs/` and keep code blocks strict-compatible
- **Changing agent guidance or top-level onboarding**: update `src/content/docs/start-here.mdx`, `src/content/docs/agent-flows/`, `astro.config.mjs`, root `CLAUDE.md`, and `slingshot-docs/documentation-policy.md` together
- **Changing API generation**: update `generate-api.ts`, then run `bun run docs:api`
- **Changing sync behavior**: update `sync-workspace-docs.ts`, then verify the generated package pages still match the workspace
