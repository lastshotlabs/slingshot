/**
 * Unit tests for the replay log system.
 *
 * Tests createInMemoryReplayStore, createReplaySequence, buildReplayEntry,
 * buildReplayEntries, and typed instrumentation helpers.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildReplayEntries,
  buildReplayEntry,
  createInMemoryReplayStore,
  createReplaySequence,
  logChannelInput,
  logChannelOpened,
  logError,
  logPhaseEntered,
  logPhaseExited,
  logPlayerJoined,
  logRngCalled,
  logScoreChanged,
  logSessionCompleted,
  logSessionCreated,
  logSessionStarted,
  logStateUpdated,
  logTimerCancelled,
  logTimerExpired,
  logTimerStarted,
  logTurnAdvanced,
} from '../../src/lib/replay';

describe('createReplaySequence', () => {
  test('starts at 1', () => {
    const seq = createReplaySequence();
    expect(seq.next).toBe(1);
  });
});

describe('buildReplayEntry', () => {
  test('creates entry with correct fields', () => {
    const seq = createReplaySequence();
    const entry = buildReplayEntry('s1', seq, 'session.created', { gameType: 'trivia' });
    expect(entry.id).toBe('replay_s1_1');
    expect(entry.sessionId).toBe('s1');
    expect(entry.sequence).toBe(1);
    expect(entry.type).toBe('session.created');
    expect(entry.data).toEqual({ gameType: 'trivia' });
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  test('auto-increments sequence', () => {
    const seq = createReplaySequence();
    const e1 = buildReplayEntry('s1', seq, 'session.created', {});
    const e2 = buildReplayEntry('s1', seq, 'session.started', {});
    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(seq.next).toBe(3);
  });
});

describe('buildReplayEntries', () => {
  test('builds multiple entries in order', () => {
    const seq = createReplaySequence();
    const entries = buildReplayEntries('s1', seq, [
      { type: 'session.created', data: { gameType: 'test' } },
      { type: 'player.joined', data: { userId: 'alice' } },
      { type: 'phase.entered', data: { phase: 'round1' } },
    ]);

    expect(entries).toHaveLength(3);
    expect(entries[0].sequence).toBe(1);
    expect(entries[1].sequence).toBe(2);
    expect(entries[2].sequence).toBe(3);
    expect(entries[0].type).toBe('session.created');
    expect(entries[1].type).toBe('player.joined');
    expect(entries[2].type).toBe('phase.entered');
  });
});

describe('createInMemoryReplayStore', () => {
  test('appendReplayEntries stores entries', async () => {
    const store = createInMemoryReplayStore();
    const seq = createReplaySequence();
    const entries = [
      buildReplayEntry('s1', seq, 'session.created', {}),
      buildReplayEntry('s1', seq, 'session.started', {}),
    ];

    await store.appendReplayEntries('s1', entries);
    const result = await store.getReplayEntries('s1', 0, 10);

    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBeFalse();
  });

  test('getReplayEntries filters by from sequence', async () => {
    const store = createInMemoryReplayStore();
    const seq = createReplaySequence();
    const entries = [
      buildReplayEntry('s1', seq, 'session.created', {}),
      buildReplayEntry('s1', seq, 'session.started', {}),
      buildReplayEntry('s1', seq, 'phase.entered', {}),
    ];

    await store.appendReplayEntries('s1', entries);
    const result = await store.getReplayEntries('s1', 1, 10);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].sequence).toBe(2);
    expect(result.entries[1].sequence).toBe(3);
  });

  test('getReplayEntries respects limit', async () => {
    const store = createInMemoryReplayStore();
    const seq = createReplaySequence();
    const entries = [
      buildReplayEntry('s1', seq, 'session.created', {}),
      buildReplayEntry('s1', seq, 'session.started', {}),
      buildReplayEntry('s1', seq, 'phase.entered', {}),
    ];

    await store.appendReplayEntries('s1', entries);
    const result = await store.getReplayEntries('s1', 0, 2);

    expect(result.entries).toHaveLength(2);
    expect(result.hasMore).toBeTrue();
  });

  test('getReplayEntries returns empty for unknown session', async () => {
    const store = createInMemoryReplayStore();
    const result = await store.getReplayEntries('unknown', 0, 10);

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBeFalse();
  });

  test('deleteReplayEntries removes session entries', async () => {
    const store = createInMemoryReplayStore();
    const seq = createReplaySequence();
    await store.appendReplayEntries('s1', [buildReplayEntry('s1', seq, 'session.created', {})]);

    await store.deleteReplayEntries('s1');
    const result = await store.getReplayEntries('s1', 0, 10);
    expect(result.entries).toHaveLength(0);
  });

  test('multiple sessions are independent', async () => {
    const store = createInMemoryReplayStore();
    const seq1 = createReplaySequence();
    const seq2 = createReplaySequence();

    await store.appendReplayEntries('s1', [buildReplayEntry('s1', seq1, 'session.created', {})]);
    await store.appendReplayEntries('s2', [
      buildReplayEntry('s2', seq2, 'session.created', {}),
      buildReplayEntry('s2', seq2, 'session.started', {}),
    ]);

    const r1 = await store.getReplayEntries('s1', 0, 10);
    const r2 = await store.getReplayEntries('s2', 0, 10);
    expect(r1.total).toBe(1);
    expect(r2.total).toBe(2);
  });
});

describe('typed instrumentation helpers', () => {
  test('logSessionCreated', () => {
    const seq = createReplaySequence();
    const entry = logSessionCreated('s1', seq, {
      gameType: 'trivia',
      hostUserId: 'alice',
      rules: { difficulty: 'hard' },
    });
    expect(entry.type).toBe('session.created');
    expect(entry.data).toEqual({
      gameType: 'trivia',
      hostUserId: 'alice',
      rules: { difficulty: 'hard' },
    });
  });

  test('logSessionStarted', () => {
    const seq = createReplaySequence();
    const entry = logSessionStarted('s1', seq, { playerCount: 4, firstPhase: 'round1' });
    expect(entry.type).toBe('session.started');
  });

  test('logSessionCompleted', () => {
    const seq = createReplaySequence();
    const entry = logSessionCompleted('s1', seq, {
      result: { type: 'winner', winners: ['alice'] },
    });
    expect(entry.type).toBe('session.completed');
  });

  test('logPlayerJoined', () => {
    const seq = createReplaySequence();
    const entry = logPlayerJoined('s1', seq, {
      userId: 'alice',
      displayName: 'Alice',
      isSpectator: false,
    });
    expect(entry.type).toBe('player.joined');
  });

  test('logPhaseEntered', () => {
    const seq = createReplaySequence();
    const entry = logPhaseEntered('s1', seq, {
      phase: 'drawing',
      timeout: 30000,
      channels: ['draw'],
    });
    expect(entry.type).toBe('phase.entered');
  });

  test('logPhaseExited', () => {
    const seq = createReplaySequence();
    const entry = logPhaseExited('s1', seq, {
      phase: 'drawing',
      reason: 'timeout',
      duration: 30000,
    });
    expect(entry.type).toBe('phase.exited');
  });

  test('logChannelOpened', () => {
    const seq = createReplaySequence();
    const entry = logChannelOpened('s1', seq, { channel: 'draw', mode: 'collect', timeout: 5000 });
    expect(entry.type).toBe('channel.opened');
  });

  test('logChannelInput', () => {
    const seq = createReplaySequence();
    const entry = logChannelInput('s1', seq, { channel: 'draw', userId: 'alice', input: 'circle' });
    expect(entry.type).toBe('channel.input');
  });

  test('logTurnAdvanced', () => {
    const seq = createReplaySequence();
    const entry = logTurnAdvanced('s1', seq, {
      previousPlayer: 'alice',
      nextPlayer: 'bob',
      turnNumber: 2,
    });
    expect(entry.type).toBe('turn.advanced');
  });

  test('logScoreChanged', () => {
    const seq = createReplaySequence();
    const entry = logScoreChanged('s1', seq, {
      userId: 'alice',
      previousScore: 10,
      newScore: 20,
      change: 10,
    });
    expect(entry.type).toBe('score.changed');
  });

  test('logTimerStarted', () => {
    const seq = createReplaySequence();
    const entry = logTimerStarted('s1', seq, {
      timerId: 't1',
      type: 'phase',
      durationMs: 30000,
    });
    expect(entry.type).toBe('timer.started');
  });

  test('logTimerExpired', () => {
    const seq = createReplaySequence();
    const entry = logTimerExpired('s1', seq, { timerId: 't1', type: 'phase' });
    expect(entry.type).toBe('timer.expired');
  });

  test('logTimerCancelled', () => {
    const seq = createReplaySequence();
    const entry = logTimerCancelled('s1', seq, {
      timerId: 't1',
      type: 'phase',
      remainingMs: 5000,
    });
    expect(entry.type).toBe('timer.cancelled');
  });

  test('logStateUpdated', () => {
    const seq = createReplaySequence();
    const entry = logStateUpdated('s1', seq, {
      patches: [{ op: 'replace', path: '/score', value: 10 }],
    });
    expect(entry.type).toBe('state.updated');
  });

  test('logRngCalled', () => {
    const seq = createReplaySequence();
    const entry = logRngCalled('s1', seq, {
      method: 'nextInt',
      args: [1, 6],
      result: 4,
    });
    expect(entry.type).toBe('rng.called');
  });

  test('logError', () => {
    const seq = createReplaySequence();
    const entry = logError('s1', seq, {
      code: 'INPUT_VALIDATION_FAILED',
      message: 'bad input',
    });
    expect(entry.type).toBe('error');
  });
});
