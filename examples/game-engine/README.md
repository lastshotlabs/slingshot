# Game Engine Example

Source-backed example for the `/examples/game-engine/` docs page.

## What it shows

Three game definitions demonstrating distinct engine features:

### Trivia (`src/trivia.ts`)

- Collect channel for player answers
- Phase state machine (question → answer → results)
- Cumulative scoring with leaderboard
- Rule presets (quick, standard, marathon)
- Lifecycle hooks for game initialization

### Draw & Guess (`src/drawing.ts`)

- Stream channel for continuous drawing data
- Race channel for first-to-guess scoring
- Turn management (sequential drawer rotation)
- Scoped state sync (drawer sees word, guessers don't)
- Custom relay filters (strokes relay to guessers only)
- Seeded RNG for deterministic word shuffling

### Blackjack (`src/blackjack.ts`)

- `standardDeck` recipe (card creation, shuffling)
- Turn channel with sequential hit/stand decisions
- Disconnect handling (auto-stand on timeout/disconnect)
- Multi-phase dealer logic (deal → turns → dealer → settle)
- Per-hand chip settlement with win/lose/push outcomes

## Files

- `src/trivia.ts` — trivia game definition
- `src/drawing.ts` — drawing game definition
- `src/blackjack.ts` — blackjack game definition
- `src/index.ts` — app composition with auth + game engine plugins

## Run

From the repo root:

```bash
bun examples/game-engine/src/index.ts
```

Set `JWT_SECRET` first.
