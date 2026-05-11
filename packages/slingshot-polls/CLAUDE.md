# slingshot-polls

Multiple-choice polls package attachable to any user content. It stays content-agnostic by
using policy handlers and stable source-type keys instead of importing consumer packages.
Composed via `createApp({ packages: [createPollsPackage(...)] })`. Per-sourceType policy
handlers are declared at construction time on the `sourceHandlers` / `voteHandlers` config
fields — there is no runtime registration API.

## Key Files

| File                       | What                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| src/index.ts               | Public API surface for package, entities, operations, and policy hooks |
| src/plugin.ts              | `createPollsPackage()` factory (`SlingshotPackageDefinition`)          |
| src/entities/poll.ts       | Poll entity definition                                                 |
| src/entities/pollVote.ts   | PollVote entity definition                                             |
| src/entities/modules.ts    | `pollModule` and `pollVoteModule` for `definePackage` consumption      |
| src/validation/config.ts   | Polls package config schema (including sourceHandlers / voteHandlers)  |
| src/operations/index.ts    | Poll operations export surface                                         |
| src/policy/index.ts        | Dispatched policy factories and policy keys                            |
| docs/human/index.md        | Package guide synced into the docs site                                |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Adding a new source-type integration**: pass an additional entry on `sourceHandlers` / `voteHandlers` when constructing the package
- **Changing config options**: update `src/validation/config.ts`, then trace the effect through `src/plugin.ts`
- **Testing**: `packages/slingshot-polls/tests/`
