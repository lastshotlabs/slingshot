/**
 * Drawing game definition (Skribbl.io-style).
 *
 * A turn-based drawing and guessing game that demonstrates:
 *   - stream channels (continuous drawing data)
 *   - race channels (first to guess correctly)
 *   - turn management (sequential drawer rotation)
 *   - scoped state sync (drawer sees the word, guessers don't)
 *   - custom relay filters
 *
 * Game flow:
 *   lobby → drawing (stream + race) → reveal → (repeat per turn) → results
 */
import { z } from 'zod';
import { defineGame } from '../../../packages/slingshot-game-engine/src/index.ts';
import type {
  ProcessHandlerContext,
  ReadonlyHandlerContext,
} from '../../../packages/slingshot-game-engine/src/index.ts';

const drawingRules = z.object({
  rounds: z.number().min(1).max(10).default(3),
  turnsPerRound: z.number().min(1).max(8).default(0), // 0 = one turn per player
  drawTimeMs: z.number().min(10000).max(120000).default(60000),
  pointsCorrectGuess: z.number().default(200),
  pointsDrawer: z.number().default(100),
  pointsSpeedBonus: z.number().default(50),
});

/** Stroke data sent over the stream channel. */
const strokeSchema = z.object({
  x: z.number(),
  y: z.number(),
  color: z.string(),
  size: z.number().min(1).max(50),
  type: z.enum(['start', 'move', 'end', 'clear']),
});

/** Guess submitted to the race channel. */
const guessSchema = z.string().min(1).max(100);

export const drawing = defineGame({
  name: 'drawing',
  display: 'Draw & Guess',
  description: 'Take turns drawing while others race to guess the word.',
  minPlayers: 3,
  maxPlayers: 12,

  rules: drawingRules,

  presets: {
    quick: { rounds: 1, drawTimeMs: 30000 },
    standard: { rounds: 3, drawTimeMs: 60000 },
    extended: { rounds: 5, drawTimeMs: 90000 },
  },

  playerStates: ['drawing', 'guessing', 'guessed', 'waiting'],
  initialPlayerState: 'waiting',

  scoring: {
    mode: 'cumulative',
    display: {
      label: 'Points',
      showChange: true,
      showRank: true,
      showStreak: true,
    },
  },

  sync: {
    mode: 'event',
    scopedSync: true,
    scopeHandler: 'scopeState',
  },

  phases: {
    drawing: {
      next: 'reveal',
      advance: 'all-channels-complete',
      timeout: ctx => (ctx.rules as { drawTimeMs: number }).drawTimeMs,
      channels: {
        strokes: {
          mode: 'stream',
          from: { state: 'drawing' },
          relay: 'custom',
          schema: strokeSchema,
          buffer: true,
          rateLimit: { max: 60, per: 1000 },
        },
        guess: {
          mode: 'race',
          from: { state: 'guessing' },
          relay: 'none',
          schema: guessSchema,
          count: ctx => {
            // All guessers can win
            const guessers = ctx.getPlayers().filter(p => p.playerState === 'guessing');
            return guessers.length;
          },
          onClaimed: 'onCorrectGuess',
          process: 'validateGuess',
        },
      },
      onEnter: 'onDrawingEnter',
    },

    reveal: {
      next: ctx => {
        const rules = ctx.rules as { rounds: number; turnsPerRound: number };
        const playerCount = ctx.getPlayers().filter(p => !p.isSpectator).length;
        const turnsPerRound = rules.turnsPerRound || playerCount;
        const totalTurns = rules.rounds * turnsPerRound;
        return ctx.currentRound >= totalTurns ? 'results' : 'drawing';
      },
      advance: 'timeout',
      timeout: 5000,
      onEnter: 'onReveal',
      onExit: 'onRevealExit',
    },

    results: {
      next: null,
      advance: 'timeout',
      timeout: 10000,
      onEnter: 'onResults',
    },
  },

  handlers: {
    onDrawingEnter(ctx: ProcessHandlerContext) {
      const players = ctx.getPlayers().filter(p => !p.isSpectator);
      const drawerIndex = (ctx.currentRound - 1) % players.length;
      const drawer = players[drawerIndex];

      // Pick a word from the word bank
      const wordBank = ctx.gameState.wordBank as string[];
      const wordIndex = (ctx.currentRound - 1) % wordBank.length;
      const word = wordBank[wordIndex];

      ctx.gameState.currentWord = word;
      ctx.gameState.currentDrawer = drawer.userId;
      ctx.gameState.guessedPlayers = [];

      // Set player states
      ctx.setPlayerState(drawer.userId, 'drawing');
      for (const p of players) {
        if (p.userId !== drawer.userId) {
          ctx.setPlayerState(p.userId, 'guessing');
        }
      }

      // Broadcast (word is filtered by scoped sync)
      ctx.broadcastState({
        event: 'drawingStarted',
        round: ctx.currentRound,
        drawer: drawer.userId,
        wordLength: word.length,
        hint: word[0] + '_'.repeat(word.length - 1),
      });
      return undefined;
    },

    validateGuess(ctx: ProcessHandlerContext, input: unknown) {
      const guess = String(input).toLowerCase().trim();
      const word = (ctx.gameState.currentWord as string).toLowerCase();
      return { valid: guess === word, reject: guess !== word };
    },

    onCorrectGuess(ctx: ProcessHandlerContext, userId: unknown) {
      const guesserId = String(userId);
      const rules = ctx.rules as {
        pointsCorrectGuess: number;
        pointsDrawer: number;
        pointsSpeedBonus: number;
      };
      const drawerId = ctx.gameState.currentDrawer as string;
      const guessedPlayers = (ctx.gameState.guessedPlayers as string[]) ?? [];
      const guessOrder = guessedPlayers.length;

      // Speed bonus decreases with each correct guess
      const speedBonus = Math.max(0, rules.pointsSpeedBonus - guessOrder * 10);
      ctx.addScore(guesserId, rules.pointsCorrectGuess + speedBonus);
      ctx.addScore(drawerId, rules.pointsDrawer);
      ctx.setPlayerState(guesserId, 'guessed');

      guessedPlayers.push(guesserId);
      ctx.gameState.guessedPlayers = guessedPlayers;

      ctx.broadcastState({
        event: 'correctGuess',
        userId: guesserId,
        guessOrder: guessOrder + 1,
      });
      return undefined;
    },

    onReveal(ctx: ProcessHandlerContext) {
      const word = ctx.gameState.currentWord as string;
      const guessedPlayers = ctx.gameState.guessedPlayers as string[];

      ctx.broadcastState({
        event: 'wordRevealed',
        word,
        correctGuesses: guessedPlayers.length,
        leaderboard: ctx.getLeaderboard(),
      });
      return undefined;
    },

    onRevealExit(ctx: ProcessHandlerContext) {
      ctx.incrementRound();
      // Reset all players to waiting
      for (const p of ctx.getPlayers()) {
        ctx.setPlayerState(p.userId, 'waiting');
      }
      return undefined;
    },

    onResults(ctx: ProcessHandlerContext) {
      const leaderboard = ctx.getLeaderboard();
      ctx.endGame({
        winners: leaderboard[0] ? [leaderboard[0].userId] : [],
        reason: 'All rounds complete',
        rankings: leaderboard.map(e => ({
          userId: e.userId,
          rank: e.rank,
          score: e.score,
        })),
      });
      return undefined;
    },
  },

  relayFilters: {
    /** Strokes relay to everyone except the drawer (they already see their own). */
    strokeRelay(_sender, _input, players, ctx: ReadonlyHandlerContext) {
      const drawerId = ctx.gameState.currentDrawer as string;
      return players.filter(p => p.userId !== drawerId).map(p => p.userId);
    },
  },

  hooks: {
    onGameStart(ctx) {
      // Build a word bank from seeded RNG for deterministic replay
      const words = [
        'elephant',
        'guitar',
        'volcano',
        'bicycle',
        'castle',
        'penguin',
        'rainbow',
        'telescope',
        'pirate',
        'dinosaur',
        'astronaut',
        'waterfall',
        'lighthouse',
        'submarine',
        'fireworks',
        'parachute',
        'snowflake',
        'treasure',
        'compass',
        'tornado',
      ];
      // Shuffle with seeded RNG
      const shuffled = [...words];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = ctx.random.int(0, i);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      ctx.gameState.wordBank = shuffled;
      ctx.gameState.currentWord = '';
      ctx.gameState.currentDrawer = '';
      ctx.gameState.guessedPlayers = [];
      return undefined;
    },
  },

  rngSeed: 'session-id',
});
