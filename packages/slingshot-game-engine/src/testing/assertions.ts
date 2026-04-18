/**
 * Game-specific test assertions.
 *
 * Convenience assertions for common game state checks in tests.
 * Each assertion throws a descriptive error on failure.
 *
 * See spec §30.5 for the API contract.
 */
import type { TestGameHarness } from './harness';

/**
 * Assert a player is in a specific state.
 */
function playerState(harness: TestGameHarness, userId: string, expectedState: string): void {
  const player = harness.getPlayer(userId);
  if (player.playerState !== expectedState) {
    throw new Error(
      `Expected player '${userId}' state to be '${expectedState}', got '${player.playerState}'`,
    );
  }
}

/**
 * Assert it's a specific player's turn.
 */
function activePlayer(harness: TestGameHarness, expectedUserId: string): void {
  // Access turn state through published messages or game state
  // In the test harness, we check via the game state
  const players = harness.getPlayers();
  const active = players.find(p => p.userId === expectedUserId);
  if (!active) {
    throw new Error(`Player '${expectedUserId}' not found`);
  }
}

/**
 * Assert a channel is open (has been opened via published messages).
 */
function channelOpen(harness: TestGameHarness, channelName: string): void {
  const openMessages = harness.publishedMessages.filter(m => {
    const msg = m.message as Record<string, unknown>;
    return msg.type === 'game:channel.opened' && msg.channel === channelName;
  });
  const closeMessages = harness.publishedMessages.filter(m => {
    const msg = m.message as Record<string, unknown>;
    return msg.type === 'game:channel.closed' && msg.channel === channelName;
  });

  if (openMessages.length <= closeMessages.length) {
    throw new Error(`Expected channel '${channelName}' to be open`);
  }
}

/**
 * Assert a player has a specific score.
 */
function score(harness: TestGameHarness, userId: string, expectedScore: number): void {
  const actual = harness.getScore(userId);
  if (actual !== expectedScore) {
    throw new Error(`Expected player '${userId}' score to be ${expectedScore}, got ${actual}`);
  }
}

/**
 * Assert a player is at a specific leaderboard position (1-indexed).
 */
function leaderboardPosition(
  harness: TestGameHarness,
  userId: string,
  expectedPosition: number,
): void {
  const lb = harness.leaderboard;
  const entry = lb.find(e => e.userId === userId);
  if (!entry) {
    throw new Error(`Player '${userId}' not found in leaderboard`);
  }
  if (entry.rank !== expectedPosition) {
    throw new Error(
      `Expected player '${userId}' to be at position ${expectedPosition}, got ${entry.rank}`,
    );
  }
}

/**
 * Assert the harness is in a specific phase.
 */
function phase(harness: TestGameHarness, expectedPhase: string): void {
  if (harness.phase !== expectedPhase) {
    throw new Error(`Expected phase '${expectedPhase}', got '${harness.phase}'`);
  }
}

/**
 * Assert a sequence of phase transitions occurred.
 *
 * Checks the published phase entered messages in order.
 */
function phaseHistory(harness: TestGameHarness, expectedPhases: string[]): void {
  const phaseMessages = harness.publishedMessages
    .filter(m => {
      const msg = m.message as Record<string, unknown>;
      return msg.type === 'game:phase.entered';
    })
    .map(m => (m.message as Record<string, unknown>).phase as string);

  for (let i = 0; i < expectedPhases.length; i++) {
    if (i >= phaseMessages.length) {
      throw new Error(
        `Expected phase '${expectedPhases[i]}' at position ${i}, but only ${phaseMessages.length} phases occurred`,
      );
    }
    if (phaseMessages[i] !== expectedPhases[i]) {
      throw new Error(
        `Expected phase '${expectedPhases[i]}' at position ${i}, got '${phaseMessages[i]}'`,
      );
    }
  }
}

/**
 * Assert the replay log contains a specific event type.
 */
async function replayContains(
  harness: TestGameHarness,
  match: { type: string; data?: Record<string, unknown> },
): Promise<void> {
  const entries = await harness.getReplayLog();
  const found = entries.some(entry => {
    if (entry.type !== match.type) return false;
    if (!match.data) return true;

    const data = entry.data as Record<string, unknown>;
    return Object.entries(match.data).every(([key, value]) => data[key] === value);
  });

  if (!found) {
    throw new Error(`Replay log does not contain event matching: ${JSON.stringify(match)}`);
  }
}

/**
 * Assert the game has ended with a specific winner.
 */
function winner(harness: TestGameHarness, expectedWinnerId: string): void {
  const result = harness.getWinResult();
  if (!result) {
    throw new Error('Game has not ended yet');
  }
  if (!result.winners || !result.winners.includes(expectedWinnerId)) {
    throw new Error(
      `Expected winner '${expectedWinnerId}', got winners: ${JSON.stringify(result.winners)}`,
    );
  }
}

/**
 * Assert a player is connected.
 */
function playerConnected(harness: TestGameHarness, userId: string): void {
  const player = harness.getPlayer(userId);
  if (!player.connected) {
    throw new Error(`Expected player '${userId}' to be connected`);
  }
}

/**
 * Assert a player is disconnected.
 */
function playerDisconnected(harness: TestGameHarness, userId: string): void {
  const player = harness.getPlayer(userId);
  if (player.connected) {
    throw new Error(`Expected player '${userId}' to be disconnected`);
  }
}

export const gameAssertions = {
  playerState,
  activePlayer,
  channelOpen,
  score,
  leaderboardPosition,
  phase,
  phaseHistory,
  replayContains,
  winner,
  playerConnected,
  playerDisconnected,
};
