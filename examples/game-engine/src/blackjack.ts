/**
 * Blackjack game definition.
 *
 * A multi-player Blackjack table that demonstrates:
 *   - standardDeck recipe (card creation, shuffling)
 *   - turn channel (sequential hit/stand decisions)
 *   - elimination scoring (bust = eliminated)
 *   - per-round scoring (each hand is independent)
 *   - disconnect handling (auto-stand on disconnect)
 *
 * Game flow:
 *   lobby → deal → playerTurns (turn channel) → dealerPlay → settle → (repeat) → results
 */
import { z } from 'zod';
import { defineGame } from '../../../packages/slingshot-game-engine/src/index.ts';
import type { ProcessHandlerContext } from '../../../packages/slingshot-game-engine/src/index.ts';
import { standardDeck } from '../../../packages/slingshot-game-engine/src/recipes/standardDeck.ts';
import type { DeckCard } from '../../../packages/slingshot-game-engine/src/recipes/standardDeck.ts';

const blackjackRules = z.object({
  hands: z.number().min(1).max(20).default(5),
  turnTimeMs: z.number().min(5000).max(60000).default(20000),
  startingChips: z.number().min(100).default(1000),
  minBet: z.number().min(1).default(10),
});

/** Player action during their turn. */
const actionSchema = z.enum(['hit', 'stand']);

/** Hand value calculation for Blackjack. */
function handValue(cards: DeckCard[]): number {
  let value = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.suit === 'joker') continue;
    if (card.rank === 'A') {
      aces++;
      value += 11;
    } else if (['K', 'Q', 'J'].includes(card.rank)) {
      value += 10;
    } else {
      value += card.value;
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }

  return value;
}

export const blackjack = defineGame({
  name: 'blackjack',
  display: 'Blackjack Table',
  description: 'Beat the dealer without going over 21.',
  minPlayers: 1,
  maxPlayers: 6,

  rules: blackjackRules,

  presets: {
    quick: { hands: 3, turnTimeMs: 15000, startingChips: 500 },
    standard: { hands: 5, turnTimeMs: 20000, startingChips: 1000 },
    highRoller: { hands: 10, turnTimeMs: 30000, startingChips: 5000 },
  },

  playerStates: ['betting', 'playing', 'standing', 'bust', 'blackjack', 'waiting'],
  initialPlayerState: 'waiting',

  scoring: {
    mode: 'cumulative',
    display: {
      label: 'Chips',
      showChange: true,
      showRank: true,
      sortDirection: 'desc',
    },
  },

  disconnect: {
    gracePeriodMs: 30000,
    turnBehavior: 'auto-action',
    autoActionHandler: 'onAutoStand',
  },

  phases: {
    deal: {
      next: 'playerTurns',
      advance: 'timeout',
      timeout: 2000,
      onEnter: 'onDeal',
    },

    playerTurns: {
      next: 'dealerPlay',
      advance: 'all-channels-complete',
      channels: {
        action: {
          mode: 'turn',
          from: { state: 'playing' },
          relay: 'all',
          schema: actionSchema,
          turnOrder: 'sequential',
          turnTimeout: ctx => (ctx.rules as { turnTimeMs: number }).turnTimeMs,
          onTurnTimeout: 'onAutoStand',
          completeWhen: 'one-round',
          process: 'processAction',
        },
      },
      onEnter: 'onPlayerTurnsEnter',
    },

    dealerPlay: {
      next: 'settle',
      advance: 'timeout',
      timeout: 3000,
      onEnter: 'onDealerPlay',
    },

    settle: {
      next: ctx => {
        const rules = ctx.rules as { hands: number };
        return ctx.currentRound >= rules.hands ? 'results' : 'deal';
      },
      advance: 'timeout',
      timeout: 4000,
      onEnter: 'onSettle',
      onExit: 'onSettleExit',
    },

    results: {
      next: null,
      advance: 'timeout',
      timeout: 10000,
      onEnter: 'onResults',
    },
  },

  handlers: {
    onDeal(ctx: ProcessHandlerContext) {
      // Create and shuffle deck
      const deck = standardDeck.create({ decks: 2 });
      // Fisher-Yates shuffle with seeded RNG
      for (let i = deck.length - 1; i > 0; i--) {
        const j = ctx.random.int(0, i);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }

      const players = ctx.getPlayers().filter(p => !p.isSpectator);
      const hands: Record<string, DeckCard[]> = {};
      let deckIndex = 0;

      // Deal 2 cards to each player
      for (const p of players) {
        hands[p.userId] = [deck[deckIndex++], deck[deckIndex++]];
        ctx.setPlayerState(p.userId, 'playing');
      }

      // Deal 2 to dealer (one face-down)
      const dealerHand = [deck[deckIndex++], deck[deckIndex++]];

      ctx.gameState.deck = deck;
      ctx.gameState.deckIndex = deckIndex;
      ctx.gameState.hands = hands;
      ctx.gameState.dealerHand = dealerHand;

      // Check for natural blackjacks
      for (const p of players) {
        if (handValue(hands[p.userId]) === 21) {
          ctx.setPlayerState(p.userId, 'blackjack');
        }
      }

      ctx.broadcastState({
        event: 'cardsDealt',
        round: ctx.currentRound,
        dealerShowing: dealerHand[0],
        playerCounts: Object.fromEntries(players.map(p => [p.userId, hands[p.userId].length])),
      });
      return undefined;
    },

    onPlayerTurnsEnter(ctx: ProcessHandlerContext) {
      // Players with blackjack skip their turn
      for (const p of ctx.getPlayers()) {
        if (p.playerState === 'blackjack') {
          ctx.setPlayerState(p.userId, 'standing');
        }
      }
      return undefined;
    },

    processAction(ctx: ProcessHandlerContext, input: unknown) {
      const action = input as string;
      const userId = ctx.getActivePlayer();
      if (!userId) return { valid: false, reason: 'No active player' };

      const hands = ctx.gameState.hands as Record<string, DeckCard[]>;
      const hand = hands[userId];
      if (!hand) return { valid: false, reason: 'No hand found' };

      if (action === 'hit') {
        const deck = ctx.gameState.deck as DeckCard[];
        let deckIndex = ctx.gameState.deckIndex as number;
        hand.push(deck[deckIndex++]);
        ctx.gameState.deckIndex = deckIndex;

        const value = handValue(hand);
        if (value > 21) {
          ctx.setPlayerState(userId, 'bust');
          ctx.broadcastState({
            event: 'playerBust',
            userId,
            value,
          });
        } else if (value === 21) {
          ctx.setPlayerState(userId, 'standing');
        }
      } else {
        ctx.setPlayerState(userId, 'standing');
      }

      return undefined;
    },

    onAutoStand(ctx: ProcessHandlerContext) {
      const userId = ctx.getActivePlayer();
      if (userId) {
        ctx.setPlayerState(userId, 'standing');
      }
      return undefined;
    },

    onDealerPlay(ctx: ProcessHandlerContext) {
      const dealerHand = ctx.gameState.dealerHand as DeckCard[];
      const deck = ctx.gameState.deck as DeckCard[];
      let deckIndex = ctx.gameState.deckIndex as number;

      // Dealer hits on 16 or less, stands on 17+
      while (handValue(dealerHand) < 17) {
        dealerHand.push(deck[deckIndex++]);
      }

      ctx.gameState.deckIndex = deckIndex;
      ctx.gameState.dealerFinalValue = handValue(dealerHand);

      ctx.broadcastState({
        event: 'dealerPlayed',
        dealerValue: ctx.gameState.dealerFinalValue,
        dealerCardCount: dealerHand.length,
      });
      return undefined;
    },

    onSettle(ctx: ProcessHandlerContext) {
      const dealerValue = ctx.gameState.dealerFinalValue as number;
      const dealerBust = dealerValue > 21;
      const hands = ctx.gameState.hands as Record<string, DeckCard[]>;
      const rules = ctx.rules as { minBet: number };
      const results: Array<{ userId: string; outcome: string; delta: number }> = [];

      for (const p of ctx.getPlayers().filter(pl => !pl.isSpectator)) {
        const hand = hands[p.userId];
        if (!hand) continue;
        const value = handValue(hand);
        let delta = 0;

        if (p.playerState === 'bust') {
          delta = -rules.minBet;
        } else if (p.playerState === 'blackjack') {
          delta = Math.floor(rules.minBet * 1.5);
        } else if (dealerBust) {
          delta = rules.minBet;
        } else if (value > dealerValue) {
          delta = rules.minBet;
        } else if (value < dealerValue) {
          delta = -rules.minBet;
        }
        // value === dealerValue is a push (delta = 0)

        if (delta !== 0) {
          ctx.addScore(p.userId, delta);
        }

        results.push({
          userId: p.userId,
          outcome: delta > 0 ? 'win' : delta < 0 ? 'lose' : 'push',
          delta,
        });
      }

      ctx.broadcastState({
        event: 'handSettled',
        dealerValue,
        dealerBust,
        results,
        leaderboard: ctx.getLeaderboard(),
      });
      return undefined;
    },

    onSettleExit(ctx: ProcessHandlerContext) {
      ctx.incrementRound();
      for (const p of ctx.getPlayers()) {
        ctx.setPlayerState(p.userId, 'waiting');
      }
      return undefined;
    },

    onResults(ctx: ProcessHandlerContext) {
      const leaderboard = ctx.getLeaderboard();
      ctx.endGame({
        winners: leaderboard[0] ? [leaderboard[0].userId] : [],
        reason: 'All hands complete',
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
    onGameStart(ctx) {
      const rules = ctx.rules as { startingChips: number };
      // Give everyone starting chips
      for (const p of ctx.getPlayers().filter(pl => !pl.isSpectator)) {
        ctx.addScore(p.userId, rules.startingChips);
      }
      ctx.gameState.hands = {};
      ctx.gameState.dealerHand = [];
      ctx.gameState.deck = [];
      ctx.gameState.deckIndex = 0;
      ctx.gameState.dealerFinalValue = 0;
      return undefined;
    },
  },

  rngSeed: 'session-id',
});
