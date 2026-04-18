/**
 * Standard playing card deck recipe.
 *
 * Utilities for creating, shuffling, comparing, and evaluating
 * standard 52-card decks with optional jokers and multi-deck support.
 *
 * See spec §23.2 for the API contract.
 */

/** Card suit. */
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

/** Card rank. */
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

/** A single card in the deck. */
export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
  readonly value: number;
}

/** A joker card. */
export interface JokerCard {
  readonly suit: 'joker';
  readonly rank: 'joker';
  readonly value: 0;
}

/** Any card in the deck (standard or joker). */
export type DeckCard = Card | JokerCard;

/** Poker hand evaluation result. */
export interface PokerHandResult {
  readonly rank: string;
  readonly value: number;
  readonly display: string;
}

const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES: Record<Rank, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** Options for creating a deck. */
export interface CreateDeckOptions {
  /** Number of jokers to include. Default: 0. */
  jokers?: number;
  /** Number of decks to combine. Default: 1. */
  decks?: number;
}

/**
 * Create a standard 52-card deck (or multi-deck with jokers).
 */
function create(options?: CreateDeckOptions): DeckCard[] {
  const jokers = options?.jokers ?? 0;
  const deckCount = options?.decks ?? 1;
  const cards: DeckCard[] = [];

  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ suit, rank, value: RANK_VALUES[rank] });
      }
    }
  }

  for (let j = 0; j < jokers; j++) {
    cards.push({ suit: 'joker', rank: 'joker', value: 0 });
  }

  return cards;
}

/**
 * Compare two cards by value.
 *
 * @returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function compare(a: DeckCard, b: DeckCard): -1 | 0 | 1 {
  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

/**
 * Evaluate a poker hand (5 cards).
 *
 * Returns the hand rank, a numeric value for comparison, and a display string.
 */
function evaluatePokerHand(cards: Card[]): PokerHandResult {
  if (cards.length !== 5) {
    throw new Error('Poker hand evaluation requires exactly 5 cards.');
  }

  const sorted = [...cards].sort((a, b) => a.value - b.value);
  const values = sorted.map(c => c.value);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(values);

  // Count rank occurrences
  const counts = new Map<number, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const countValues = [...counts.values()].sort((a, b) => b - a);

  // Royal flush
  if (isFlush && isStraight && values[4] === 14 && values[0] === 10) {
    return { rank: 'royal-flush', value: 1000, display: 'Royal Flush' };
  }

  // Straight flush
  if (isFlush && isStraight) {
    return {
      rank: 'straight-flush',
      value: 900 + values[4],
      display: `Straight Flush, ${rankName(values[4])} high`,
    };
  }

  // Four of a kind
  if (countValues[0] === 4) {
    const fourEntry = [...counts.entries()].find(([, c]) => c === 4);
    const fourVal = fourEntry ? fourEntry[0] : 0;
    return {
      rank: 'four-of-a-kind',
      value: 800 + fourVal,
      display: `Four of a Kind, ${rankName(fourVal)}s`,
    };
  }

  // Full house
  if (countValues[0] === 3 && countValues[1] === 2) {
    const threeEntry = [...counts.entries()].find(([, c]) => c === 3);
    const threeVal = threeEntry ? threeEntry[0] : 0;
    const twoEntry = [...counts.entries()].find(([, c]) => c === 2);
    const twoVal = twoEntry ? twoEntry[0] : 0;
    return {
      rank: 'full-house',
      value: 700 + threeVal * 15 + twoVal,
      display: `Full House, ${rankName(threeVal)}s over ${rankName(twoVal)}s`,
    };
  }

  // Flush
  if (isFlush) {
    return { rank: 'flush', value: 600 + values[4], display: `Flush, ${rankName(values[4])} high` };
  }

  // Straight
  if (isStraight) {
    return {
      rank: 'straight',
      value: 500 + values[4],
      display: `Straight, ${rankName(values[4])} high`,
    };
  }

  // Three of a kind
  if (countValues[0] === 3) {
    const threeOfKindEntry = [...counts.entries()].find(([, c]) => c === 3);
    const threeVal = threeOfKindEntry ? threeOfKindEntry[0] : 0;
    return {
      rank: 'three-of-a-kind',
      value: 400 + threeVal,
      display: `Three of a Kind, ${rankName(threeVal)}s`,
    };
  }

  // Two pair
  if (countValues[0] === 2 && countValues[1] === 2) {
    const pairs = [...counts.entries()]
      .filter(([, c]) => c === 2)
      .map(([v]) => v)
      .sort((a, b) => b - a);
    return {
      rank: 'two-pair',
      value: 300 + pairs[0] * 15 + pairs[1],
      display: `Two Pair, ${rankName(pairs[0])}s and ${rankName(pairs[1])}s`,
    };
  }

  // One pair
  if (countValues[0] === 2) {
    const pairEntry = [...counts.entries()].find(([, c]) => c === 2);
    const pairVal = pairEntry ? pairEntry[0] : 0;
    return { rank: 'one-pair', value: 200 + pairVal, display: `Pair of ${rankName(pairVal)}s` };
  }

  // High card
  return { rank: 'high-card', value: 100 + values[4], display: `${rankName(values[4])} High` };
}

function checkStraight(values: number[]): boolean {
  // Normal straight
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1] + 1) {
      // Check for Ace-low straight (A-2-3-4-5)
      if (
        i === 4 &&
        values[4] === 14 &&
        values[0] === 2 &&
        values[1] === 3 &&
        values[2] === 4 &&
        values[3] === 5
      ) {
        return true;
      }
      return false;
    }
  }
  return true;
}

function rankName(value: number): string {
  switch (value) {
    case 14:
      return 'Ace';
    case 13:
      return 'King';
    case 12:
      return 'Queen';
    case 11:
      return 'Jack';
    default:
      return String(value);
  }
}

export const standardDeck = {
  create,
  compare,
  evaluatePokerHand,
  SUITS,
  RANKS,
  RANK_VALUES,
};
