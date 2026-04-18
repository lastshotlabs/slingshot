/**
 * Trivia game definition.
 *
 * A simple multiplayer trivia game that demonstrates defineGame(),
 * phases, channels, scoring, timers, and lifecycle hooks.
 *
 * Game flow:
 *   lobby → question → answer → (repeat per round) → results
 */
import { z } from 'zod';
import { defineGame } from '../../../packages/slingshot-game-engine/src/index.ts';
import type { ProcessHandlerContext } from '../../../packages/slingshot-game-engine/src/index.ts';

const triviaRules = z.object({
  rounds: z.number().min(1).max(20).default(5),
  timePerQuestion: z.number().min(5000).max(60000).default(15000),
  pointsCorrect: z.number().default(100),
  pointsSpeed: z.number().default(50),
});

export const trivia = defineGame({
  name: 'trivia',
  display: 'Trivia Night',
  description: 'Answer questions fast to earn the most points.',
  minPlayers: 2,
  maxPlayers: 8,

  rules: triviaRules,

  presets: {
    quick: { rounds: 3, timePerQuestion: 10000 },
    standard: { rounds: 5, timePerQuestion: 15000 },
    marathon: { rounds: 15, timePerQuestion: 20000 },
  },

  playerStates: ['answering', 'waiting', 'correct', 'wrong'],
  initialPlayerState: 'waiting',

  scoring: {
    mode: 'cumulative',
    display: {
      label: 'Points',
      showChange: true,
      showRank: true,
    },
  },

  phases: {
    question: {
      next: 'answer',
      advance: 'all-channels-complete',
      timeout: ctx => (ctx.rules as { timePerQuestion: number }).timePerQuestion,
      channels: {
        answer: {
          mode: 'collect',
          from: 'all-players',
          relay: 'none',
          schema: z.string().min(1),
          revealMode: 'after-close',
        },
      },
      onEnter: 'onQuestionEnter',
    },

    answer: {
      next: ctx => {
        const rules = ctx.rules as { rounds: number };
        return ctx.currentRound >= rules.rounds ? 'results' : 'question';
      },
      advance: 'timeout',
      timeout: 5000,
      onEnter: 'onAnswerReveal',
      onExit: 'onAnswerExit',
    },

    results: {
      next: null,
      advance: 'timeout',
      timeout: 10000,
      onEnter: 'onResults',
    },
  },

  handlers: {
    onQuestionEnter(ctx: ProcessHandlerContext) {
      const round = ctx.currentRound;
      ctx.setPlayerStates(
        ctx.getPlayers().map(p => p.userId),
        'answering',
      );
      ctx.broadcastState({
        event: 'newQuestion',
        round,
        question: (ctx.gameState.questions as string[])?.[round - 1] ?? `Question ${round}`,
      });
      return undefined;
    },

    onAnswerReveal(ctx: ProcessHandlerContext) {
      const rules = ctx.rules as { pointsCorrect: number; pointsSpeed: number };
      const inputs = ctx.getChannelInputs('answer');
      const correctAnswer = (ctx.gameState.answers as string[])?.[ctx.currentRound - 1] ?? '';

      for (const [userId, { input }] of inputs) {
        if (String(input).toLowerCase() === correctAnswer.toLowerCase()) {
          ctx.addScore(userId, rules.pointsCorrect);
          ctx.setPlayerState(userId, 'correct');
        } else {
          ctx.setPlayerState(userId, 'wrong');
        }
      }

      ctx.broadcastState({
        event: 'answerRevealed',
        correctAnswer,
        leaderboard: ctx.getLeaderboard(),
      });
      return undefined;
    },

    onAnswerExit(ctx: ProcessHandlerContext) {
      ctx.incrementRound();
      return undefined;
    },

    onResults(ctx: ProcessHandlerContext) {
      const leaderboard = ctx.getLeaderboard();
      const winner = leaderboard[0];

      ctx.endGame({
        winners: winner ? [winner.userId] : [],
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

  hooks: {
    onSessionCreated(ctx) {
      ctx.gameState.questions = [];
      ctx.gameState.answers = [];
    },

    onGameStart(ctx) {
      const rules = ctx.rules as { rounds: number };
      const questions: string[] = [];
      const answers: string[] = [];

      for (let i = 0; i < rules.rounds; i++) {
        questions.push(`Sample question ${i + 1}`);
        answers.push(`answer${i + 1}`);
      }

      ctx.gameState.questions = questions;
      ctx.gameState.answers = answers;
      return undefined;
    },
  },

  rngSeed: 'session-id',
});
