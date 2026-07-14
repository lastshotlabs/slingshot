# slingshot-game-engine

Multiplayer game state **package**. Config-driven phases, channels, turns,
scoring, timers, seeded RNG, replay log, and disconnect recovery. Authored via
`definePackage(...)` and consumed through
`createApp({ packages: [createGameEnginePackage(...)] })`. Factory pattern with
closure-owned state, no singletons.

## Key Files

### Package and Entry

| File              | What                                                      |
| ----------------- | --------------------------------------------------------- |
| src/index.ts      | Public API surface (package, defineGame, entities, types) |
| src/plugin.ts     | `createGameEnginePackage()` factory                       |
| src/defineGame.ts | `defineGame()` DSL + validation                           |

### Entities

| File                        | What                                                        |
| --------------------------- | ----------------------------------------------------------- |
| src/entities/gameSession.ts | GameSession entity definition                               |
| src/entities/gamePlayer.ts  | GamePlayer entity definition                                |
| src/entities/factories.ts   | Entity repository factory wiring by StoreType               |
| src/entities/modules.ts     | `buildGameEngineEntityModules(...)` — manual adapter wiring |

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

## Display tokens — casting a game to a real TV

Every game has a TV view. Until now none could actually be **cast**: open the TV route on a
Chromecast, a smart TV, or any browser that has never logged in, and every request 401s. It
only appeared to work because the host opened the TV as a tab in their own authenticated
browser, silently borrowing their session. In a music game where the TV is the speaker, that
meant no TV and therefore no sound.

The host mints a short-lived, single-match, **read-only** token; the TV carries it.

```
POST {mountPath}/sessions/:id/display-token          -> { token, sessionId, expiresAt }
POST {mountPath}/sessions/:id/display-token/revoke   -> { revoked, displayEpoch }
```

**Adopting it in an app is two lines.** Widen exactly the routes the TV needs, and nothing
else:

```ts
import { getActorId } from '@lastshotlabs/slingshot-core';
import { getDisplaySessionId } from '@lastshotlabs/slingshot-game-engine';

const userId = getActorId(c); // null for a TV
const display = getDisplaySessionId(c); // the session id, for a TV

if (!userId && display !== match.gameSessionId) {
  return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
}
return c.json(sanitizeForSpectator(match)); // <- YOUR existing redaction, unchanged
```

The TV must go through the same spectator projection every other client uses. The framework
deliberately does **not** redact for you: it does not know what your game considers a spoiler
(hitshot's pre-reveal year, hotseat's undealt deck, blankslate's unrevealed words), and
guessing would be worse than not trying.

On the socket, the TV sends `game:display.subscribe` with `{ token }` and is subscribed to the
session + spectator rooms. It sends nothing else, ever.

### The threat model, stated plainly

A display token lives in a URL, on a screen, in somebody's living room. Guests can read it off
the TV. It will be photographed. **Assume it leaks — and make that a non-event.**

- The actor it produces has `kind: 'display'` and **`id: null`**. `userAuth` requires
  `kind === 'user'` AND a non-null `id`, so a display token **cannot satisfy `userAuth`
  anywhere, in any package, present or future**. Read-only is _structural_, not a check
  somebody has to remember to write — every route that guards on `getActorId(c)` already
  rejects it, including routes written before display tokens existed.
- It is bound to ONE `sessionId`. It is useless against any other session.
- It expires, it dies the moment the session completes, and the host can revoke every
  outstanding token with one call (`displayEpoch` is a counter on the session; revoke
  increments it, and verification demands an exact match — no revocation list to drift).
- It carries no user identity, no roles, and no claims beyond its own session.

A display token is a key to a window, not a key to the house.

### It also closed a live hole

The framework's `defaultRoomSubscribeGuard` protects only `…:player:<uid>` rooms and returns
`true` for everything else. The engine set no guard, so **any authenticated socket could
subscribe to `sessions:<id>:host`** — the host-only room that `broadcastTo('host', …)` and
`publishToHost()` write to — **or to any other session's rooms entirely.** That was true in all
four shipped games. `lib/roomAccess.ts` now enforces: you may only subscribe to rooms of a
session you are in, and only to the rooms within it that are yours.

## ctx.services — reaching a framework capability from a handler

`ProcessHandlerContext.services` is how a game handler resolves a framework capability
(`ctx.services?.capabilities.require(AiClientCap)`).

**It was declared, documented, and never wired.** `getHookServices` was a getter over a
late-bound accessor that nothing ever supplied, so `ctx.services` was `undefined` in every
game, always. That is why hotseat's LLM never generated a card in production: the AI client
was registered, booted and pre-warmed, and the handler that had to _find_ it looked into an
empty socket and silently dealt from the house deck. Hundreds of tests were green because
every one called the generation function directly; none drove the handler that has to resolve
the client.

The plugin now supplies it. **`TestGameHarness` deliberately does not** — so `ctx.services`
stays `undefined` in sims, which is what keeps them hermetic and lets a game take a
no-credentials fallback path in tests. Guard for it:

```ts
const client = ctx.services?.capabilities.maybe(AiClientCap) ?? null;
if (!client) return houseDeck(); // tests, and apps with no key
```

## Connections

- **Imports from**: `slingshot-core` (package authoring, entities, WS, context), `slingshot-entity` (operations, factories, policy)
- **Imported by**: application code via `createGameEnginePackage()` + `defineGame()`

## Common Tasks

- **Adding a channel mode**: add case in `src/lib/channels.ts` `recordSubmission()`, add to `ChannelMode` type in `src/types/models.ts`
- **Adding a phase advance trigger**: update `PhaseAdvanceTrigger` type, handle in `src/lib/phases.ts`
- **A phase that is a computation, not a wait** (deck prep, skip-if-not-applicable, terminal checks): call `ctx.advancePhase()` from the phase's `onEnter`, optionally after `ctx.setNextPhase(...)`. The advance cannot run inline — `onEnter` executes inside the transition — so the runtime records it and replays it once the transition settles. Chains resolve in a single transition; a cycle throws after `MAX_SELF_ADVANCE_CHAIN` (16) hops. An _external_ advance (host control, phase timeout) that lands mid-transition is still dropped by the reentrancy guard.
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
