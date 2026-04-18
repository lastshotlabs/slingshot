# slingshot-game-engine

Multiplayer game state engine. Config-driven phases, channels, turns, scoring,
timers, seeded RNG, replay log, and disconnect recovery — all as a standard
slingshot plugin. Factory pattern with closure-owned state, no singletons.

## Key Files

### Plugin and Entry

| File              | What                                                     |
| ----------------- | -------------------------------------------------------- |
| src/index.ts      | Public API surface (plugin, defineGame, entities, types) |
| src/plugin.ts     | `createGameEnginePlugin()` factory                       |
| src/defineGame.ts | `defineGame()` DSL + validation                          |

### Entities

| File                        | What                                          |
| --------------------------- | --------------------------------------------- |
| src/entities/gameSession.ts | GameSession entity definition                 |
| src/entities/gamePlayer.ts  | GamePlayer entity definition                  |
| src/entities/factories.ts   | Entity repository factory wiring by StoreType |

### Operations

| File                      | What                                                            |
| ------------------------- | --------------------------------------------------------------- |
| src/operations/session.ts | Session operations (status transitions, lookups)                |
| src/operations/player.ts  | Player operations (lookups, score increment, connection, count) |

### Types

| File                  | What                                                              |
| --------------------- | ----------------------------------------------------------------- |
| src/types/models.ts   | All game domain model types (sessions, players, phases, channels) |
| src/types/config.ts   | Plugin config type (`GameEnginePluginConfig`)                     |
| src/types/adapters.ts | Provider interfaces (ReplayStore, SessionLeaseAdapter, etc.)      |
| src/types/hooks.ts    | Convenience re-export of lifecycle hook types from models         |
| src/types/state.ts    | Plugin state key + `GameEnginePluginState` interface              |

### Validation

| File                      | What                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| src/validation/config.ts  | Zod plugin config schema (`GameEnginePluginConfigSchema`)        |
| src/validation/input.ts   | WS message payload schemas (game:input, subscribe, reconnect)    |
| src/validation/session.ts | REST request body schemas (create, join, update rules/content)   |
| src/validation/player.ts  | REST request body schemas (kick, team/role assign, lobby update) |

### Lib (Runtime)

| File                      | What                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| src/lib/phases.ts         | Phase state machine (enter, advance, sub-phases)                   |
| src/lib/channels.ts       | Channel runtime (6 modes: collect, vote, race, stream, etc.)       |
| src/lib/sessionControl.ts | Public app-facing control surface for active session runtimes      |
| src/lib/turns.ts          | Turn order manager (sequential, random, custom)                    |
| src/lib/scoring.ts        | Scoring engine (scores, leaderboard, team aggregation)             |
| src/lib/timers.ts         | Timer service (per-phase, per-turn timeouts)                       |
| src/lib/rng.ts            | Seeded Mulberry32 PRNG                                             |
| src/lib/gameLoop.ts       | Tick loop, input buffer, scheduled events                          |
| src/lib/handlers.ts       | `ProcessHandlerContext` builder for lifecycle hooks                |
| src/lib/display.ts        | WS room routing + relay resolution                                 |
| src/lib/input.ts          | Input pipeline (authorize, validate, rate limit)                   |
| src/lib/disconnect.ts     | Disconnect/reconnect, AFK detection, channel behavior, replacement |
| src/lib/hooks.ts          | Lifecycle hooks dispatcher (error-isolated invoke\* helpers)       |
| src/lib/replay.ts         | Replay log, in-memory store, typed instrumentation helpers         |
| src/lib/state.ts          | Game state container, JSON-patch diffing, scoped player views      |
| src/lib/players.ts        | Role assignment, team balancing, player filtering                  |
| src/lib/rateLimit.ts      | Per-player per-channel sliding window rate limiter                 |
| src/lib/serialize.ts      | Map/Set to JSON serialization for entity persistence               |
| src/lib/sessionLease.ts   | Redis-backed session leases for multi-instance failover            |
| src/lib/childSessions.ts  | Nested child session lifecycle (mini-games, result propagation)    |
| src/lib/cleanup.ts        | TTL-based session garbage collection and archival sweeps           |
| src/lib/content.ts        | Content provider loading, validation, and freeze                   |
| src/lib/rules.ts          | Rules schema resolution, preset merging, and freeze                |

### Middleware

| File                                 | What                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| src/middleware/hostOnlyGuard.ts      | REST guard rejecting non-host users on host-only routes               |
| src/middleware/playerJoinGuard.ts    | REST guard validating capacity, status, and duplicate on join         |
| src/middleware/playerLeaveGuard.ts   | REST guard handling host transfer and cleanup on leave                |
| src/middleware/sessionCreateGuard.ts | REST guard validating gameType, generating join code, resolving rules |
| src/middleware/startGameGuard.ts     | REST guard validating min/max players before game start               |

### WebSocket

| File               | What                                                            |
| ------------------ | --------------------------------------------------------------- |
| src/ws/incoming.ts | WS incoming handlers (game:input, subscribe, reconnect, stream) |
| src/ws/hostOnly.ts | WS-level host-only guard for privileged events                  |

### Manifest

| File                               | What                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| src/manifest/gameEngineManifest.ts | Multi-entity manifest declaration for manifest-mode bootstrap           |
| src/manifest/runtime.ts            | Manifest-mode runtime wiring (handler/hook registries, adapter capture) |

### Policy

| File                | What                                              |
| ------------------- | ------------------------------------------------- |
| src/policy/index.ts | Game session access policy dispatched by gameType |

### Events and Errors

| File          | What                                                    |
| ------------- | ------------------------------------------------------- |
| src/events.ts | Event bus augmentation + client-safe event registration |
| src/errors.ts | `GameErrorCode` registry + `GameError` class            |

### Recipes

| File                         | What                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| src/recipes/index.ts         | Barrel export for all recipe modules                                   |
| src/recipes/standardDeck.ts  | 52-card deck: create, shuffle, compare, poker hand evaluation          |
| src/recipes/gridBoard.ts     | 2D grid: create, adjacency, BFS pathfinding, flood fill                |
| src/recipes/elimination.ts   | Elimination scoring: eliminate lowest, threshold, last standing        |
| src/recipes/blindSchedule.ts | Poker blind schedule: escalating levels by elapsed time                |
| src/recipes/wordValidator.ts | Word validation: basic checks, fuzzy match (Levenshtein), multi-answer |

### Testing

| File                           | What                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| src/testing/index.ts           | Barrel export for test harness, simulated player, assertions     |
| src/testing/harness.ts         | `TestGameHarness` — self-contained in-memory game session        |
| src/testing/simulatedPlayer.ts | `SimulatedPlayer` — programmable bot with per-channel strategies |
| src/testing/timeControl.ts     | `MockClock` — deterministic time advancement for tests           |
| src/testing/assertions.ts      | `gameAssertions` — phase, score, leaderboard, replay assertions  |

### Unit Tests

| File                         | What                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| tests/unit/turns.test.ts     | Turn state machine, advance, reverse, cycle, skip, manipulation |
| tests/unit/phases.test.ts    | Phase state, advance triggers, sub-phases, channel completion   |
| tests/unit/scoring.test.ts   | Score engine, leaderboard, team aggregation, streaks            |
| tests/unit/channels.test.ts  | Channel modes (collect, race, free), freeze, close              |
| tests/unit/state.test.ts     | Deep clone, JSON validation, RFC 6902 diff/patch, private state |
| tests/unit/replay.test.ts    | Replay store, sequence, entry building, typed log helpers       |
| tests/unit/input.test.ts     | Channel authorization, input accept/reject, schema validation   |
| tests/unit/rateLimit.test.ts | Sliding window rate limiter, key composition                    |

## Connections

- **Imports from**: `slingshot-core` (plugin contract, entities, WS, context), `slingshot-entity` (operations, factories, policy)
- **Imported by**: application code via `createGameEnginePlugin()` + `defineGame()`

## Common Tasks

- **Adding a channel mode**: add case in `src/lib/channels.ts` `recordSubmission()`, add to `ChannelMode` type in `src/types/models.ts`
- **Adding a phase advance trigger**: update `PhaseAdvanceTrigger` type, handle in `src/lib/phases.ts`
- **Adding a handler context method**: add to `ProcessHandlerContext` interface in `src/types/models.ts`, implement in `src/lib/handlers.ts`
- **Extending app-facing runtime controls**: update `src/types/state.ts`, implement in `src/lib/sessionControl.ts`, and wire through `src/plugin.ts`
- **Adding a recipe**: create file in `src/recipes/`, export from `src/recipes/index.ts`
- **Adding a middleware guard**: create file in `src/middleware/`, wire in `src/plugin.ts`
- **Adding a WS handler**: add to `src/ws/incoming.ts`, add validation schema in `src/validation/input.ts`
- **Adding a REST endpoint schema**: add schema to `src/validation/session.ts` or `src/validation/player.ts`
- **Changing config**: update `src/types/config.ts` type, `src/validation/config.ts` schema, trace through `src/plugin.ts`
- **Adding a test assertion**: add function to `src/testing/assertions.ts`, export from `src/testing/index.ts`
- **Adding a lifecycle hook**: add to `GameLifecycleHooks` in `src/types/models.ts`, add invoke helper in `src/lib/hooks.ts`
- **Adding a replay event type**: add to `ReplayEventType` in `src/types/models.ts`, add typed log helper in `src/lib/replay.ts`
