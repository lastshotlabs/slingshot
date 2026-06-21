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
- **Changing agent guidance or top-level onboarding**: update `src/content/docs/start-here.mdx`, `src/content/docs/agent-flows/`, `astro.config.mjs`, root `CLAUDE.md`, and `slingshot-specs/documentation-policy.md` together
- **Changing API generation**: update `generate-api.ts`, then run `bun run docs:api`
- **Changing sync behavior**: update `sync-workspace-docs.ts`, then verify the generated package pages still match the workspace

## Doc Authoring Locations

For any given package, three doc files coexist with overlapping audiences. They are authored
independently — only the docs site is generated:

| File                                                            | Authored where | Synced from                                                    |
| --------------------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| `packages/<pkg>/CLAUDE.md`                                      | hand-authored  | not synced — agent-facing, navigational                        |
| `packages/<pkg>/README.md`                                      | hand-authored  | not synced — npm/GitHub-facing (see drift note below)          |
| `packages/<pkg>/docs/human/index.md`                            | hand-authored  | canonical user-facing source                                   |
| `packages/<pkg>/docs/{maintainer,operator,...}/**/*.md`         | hand-authored  | canonical per-lane source                                      |
| `packages/docs/src/content/docs/packages/<pkg>/overview.md`     | generated      | from `docs/human/index.md` via `bun run docs:sync`             |
| `packages/docs/src/content/docs/packages/<pkg>/<lane>/**/*.md`  | generated      | from `docs/<lane>/**/*.md` via `bun run docs:sync`             |
| `packages/docs/src/content/docs/api/<pkg>/index.mdx`            | generated      | from `packages/<pkg>/src/**/*.ts` TSDoc via `bun run docs:api` |
| `packages/docs/src/content/docs/{guides,examples,...}/**/*.mdx` | hand-authored  | top-level docs; not tied to any single package                 |

### Drift hazard: README ↔ docs/human/index.md

`sync-workspace-docs.ts` reads from `<pkg>/docs/` and writes into the Astro tree. It does
**not** touch `<pkg>/README.md`. When the human guide and the README cover the same content
(dependency tables, install snippets, the high-level "what does this package do" blurb), they
drift silently — there is no validation step.

**Convention:** keep `README.md` thin. Install / usage one-liner, link to the human guide
for the canonical content, then a short "what it does" paragraph. Anything deeper belongs
in `docs/human/index.md` only. If a README needs to mirror dependency tables or
configuration walkthroughs, expect to update it by hand every time the human guide changes.
