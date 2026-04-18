---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-game-engine
---

`@lastshotlabs/slingshot-game-engine` adds config-driven multiplayer game state management as a
standard slingshot plugin. Games are defined declaratively via `defineGame()` and registered with
the plugin at startup. The engine handles phases, channels, turns, scoring, timers, seeded RNG,
replay logging, and disconnect recovery — all driven by configuration, not per-game boilerplate.

## When To Use It

Use this package when your app needs:

- multiplayer game sessions with lobby, playing, paused, and completed lifecycle states
- config-driven phase state machines with conditional transitions and sub-phases
- channel-based input collection (collect, race, stream, turn, vote, free modes)
- turn order management, scoring, timers, and leaderboards
- deterministic replay via seeded PRNG and replay log
- disconnect/reconnect handling with configurable grace periods and host transfer

Do not use it for single-player experiences with no shared state or for real-time physics
simulations that need sub-16ms tick rates. The engine targets turn-based and round-based
multiplayer games, not twitch gameplay.

## What You Need Before Wiring It In

The plugin depends on `slingshot-core` and `slingshot-entity`. Auth is expected to be wired in
separately via `slingshot-auth` — the engine's entity routes use `userAuth` as the default
auth middleware.

You need at least one game definition created via `defineGame()` and registered with the
plugin config. Without a registered game type, session creation will fail with
`GAME_TYPE_NOT_FOUND`.

## Minimum Setup

Defaults include:

- `mountPath: '/game'`
- `wsEndpoint: 'game'`
- `cleanup.sweepInterval: 300_000` (5 minutes)
- `disconnect.gracePeriodMs: 60_000`
- `disconnect.maxDisconnects: 5`
- `wsRateLimit.maxMessages: 30` per 1-second window
- `heartbeat.intervalMs: 30_000`
- `recovery.windowMs: 120_000`
- `disableRoutes: []`

All cleanup, disconnect, heartbeat, recovery, and rate-limit sections have sensible defaults
and can be omitted entirely.

## What You Get

The package registers the `GameSession` and `GamePlayer` entities, then layers game-specific
behavior on top:

- a `defineGame()` DSL that validates phase references, channel handlers, and sub-phase
  structure at startup
- phase state machine with advance triggers (all-submitted, timer, manual, custom)
- six channel modes: collect, race, stream, turn, vote, free
- turn order management (round-robin, random, score-based, manual)
- scoring engine with per-player and per-team aggregation
- timer service with per-phase and per-turn timers
- seeded Mulberry32 PRNG for deterministic replay
- tick-based game loop with input buffering, scheduled events, and delta sync
- WS endpoint with subscribe, reconnect, input, and stream message types
- disconnect/reconnect handling with grace periods, auto-kick, and host transfer
- TTL-based session cleanup sweep with optional archiving
- nested (child) session support
- session lease system for multi-instance deployments
- replay log with in-memory default store and pluggable `ReplayStore` adapter
- plugin state published under `GAME_ENGINE_PLUGIN_STATE_KEY`
- a narrow `sessionControls` surface on plugin state for active-session inspection and host/app
  orchestration without exposing mutable runtime internals
- `sessionControls.submitInput()` for server-side injection of validated channel input through
  the normal realtime pipeline
- `sessionControls.mutate()` for app-controlled active-session mutations through the same
  `ProcessHandlerContext` surface game handlers receive

## Common Customization

The most important decisions are:

- game definitions: the `defineGame()` call is where all game-specific behavior lives —
  phases, channels, handlers, scoring, content, and lifecycle hooks
- `disconnect` config: grace period, pause behavior, and turn behavior for disconnected players
- `cleanup` TTLs: how long completed, abandoned, and idle lobby sessions persist
- `wsRateLimit`: tune for your expected input frequency
- `disableRoutes`: suppress parts of the default REST route surface

If you need to change behavior, start in:

- `src/plugin.ts` for lifecycle, route registration, WS wiring, and sweep startup
- `src/defineGame.ts` for game definition validation and defaults
- `src/validation/config.ts` for plugin config schema
- `src/lib/phases.ts`, `src/lib/channels.ts`, `src/lib/turns.ts` for state machine internals
- `src/lib/handlers.ts` for the `ProcessHandlerContext` API available to game handlers
- `src/lib/hooks.ts` for lifecycle hook invocation (error-isolated dispatchers)
- `src/lib/disconnect.ts` for disconnect/reconnect, AFK detection, and channel behavior

## Gotchas

- Every game type must be registered via the plugin config before any session of that type
  can be created. Hot-registration at runtime is not supported.
- The `defineGame()` call validates handler references at startup — referencing a phase or
  channel handler that doesn't exist in the definition will throw immediately.
- The game loop tick rate halves automatically on overrun and restores when the system
  catches up. If your handlers are slow, watch for tick rate warnings.
- Session state mutations are serialized through a per-session async mutex. Long-running
  handlers block all other operations on that session.
- The in-memory replay store is the default. For production persistence, provide a
  `ReplayStore` adapter (e.g., backed by a database or object storage).
- App code should use `getContext(app).pluginState.get(GAME_ENGINE_PLUGIN_STATE_KEY)?.sessionControls`
  for active-session lookup and orchestration. Use `advancePhase()` for manual phase transitions,
  `submitInput()` when you need to drive a channel as if input arrived over WebSocket, and
  `mutate()` when you need a controlled host/admin mutation with a fresh snapshot plus
  `ProcessHandlerContext`. Do not treat plugin state as a source of mutable runtime references.
- The session lease system is opt-in. Without a `SessionLeaseAdapter`, the engine assumes
  single-instance mode and auto-succeeds all lease operations.
- Content providers are called during game start. If your provider makes network requests,
  game start latency includes that round trip.
- Lifecycle hooks are error-isolated — a failing `onPhaseEnter` hook logs the error but
  does not block the phase transition. The one exception is `onGameStart`, which can
  return `{ cancel: true, reason }` to abort game start.
- Stream channel rate limiting silently drops excess messages (no error sent to client).
  The default limit is 30 messages per second per player per channel.
- AFK detection uses two signals: consecutive turn timeouts and inactivity threshold.
  A player flagged AFK stays flagged until they send any input.
- Replay instrumentation helpers in `src/lib/replay.ts` produce typed entries but do not
  auto-append to the store — the orchestration layer is responsible for calling
  `appendReplayEntries()` with the produced entries.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/defineGame.ts`
- `src/validation/config.ts`
- `src/entities/gameSession.ts`
- `src/entities/gamePlayer.ts`
- `src/operations/session.ts`
- `src/operations/player.ts`
- `src/lib/phases.ts`
- `src/lib/channels.ts`
- `src/lib/turns.ts`
- `src/lib/scoring.ts`
- `src/lib/timers.ts`
- `src/lib/gameLoop.ts`
- `src/lib/handlers.ts`
- `src/lib/hooks.ts`
- `src/lib/disconnect.ts`
- `src/lib/replay.ts`
- `src/lib/state.ts`
- `src/ws/incoming.ts`
