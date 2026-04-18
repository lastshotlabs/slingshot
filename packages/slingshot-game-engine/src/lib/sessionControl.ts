import type { GamePlayerState } from '../types/models';
import type {
  GameEngineActiveSessionSnapshot,
  GameEngineAdvancePhaseInput,
  GameEngineSessionControls,
} from '../types/state';
import { hostRoom, playerRoom, sessionRoom } from './display';
import { buildLeaderboard, getScore } from './scoring';
import {
  type SessionRuntime,
  advancePhase,
  processInputPipeline,
  refreshHandlerContext,
} from './sessionRuntime';

function snapshotPlayer(
  runtimePlayer: SessionRuntime['players'] extends Map<string, infer T> ? T : never,
) {
  const player: GamePlayerState = {
    userId: runtimePlayer.userId,
    displayName: runtimePlayer.displayName,
    role: runtimePlayer.role,
    team: runtimePlayer.team,
    playerState: runtimePlayer.playerState,
    score: runtimePlayer.score,
    connected: runtimePlayer.connected,
    isHost: runtimePlayer.isHost,
    isSpectator: runtimePlayer.isSpectator,
    joinOrder: runtimePlayer.joinOrder,
  };
  return player;
}

/**
 * Create the narrow public control surface for active session runtimes.
 *
 * The returned object is safe to publish through plugin state because it
 * exposes read-only snapshots and explicit control methods instead of leaking
 * mutable `SessionRuntime` references to app code.
 */
export function createSessionControls(
  activeRuntimes: Map<string, SessionRuntime>,
): GameEngineSessionControls {
  function toSnapshot(runtime: SessionRuntime): GameEngineActiveSessionSnapshot {
    const phaseTimerId = runtime.phaseState.phaseTimerId;
    const phaseEndsAt = phaseTimerId
      ? (runtime.timerState.timers.get(phaseTimerId)?.endsAt ?? null)
      : null;

    return {
      sessionId: runtime.sessionId,
      gameType: runtime.gameType,
      currentPhase: runtime.phaseState.currentPhase,
      currentSubPhase: runtime.phaseState.currentSubPhase,
      currentRound: runtime.currentRound,
      phaseEndsAt,
      gameState: structuredClone(runtime.gameState),
      players: [...runtime.players.values()]
        .sort((left, right) => left.joinOrder - right.joinOrder)
        .map(snapshotPlayer),
      activeChannels: [...runtime.channels.values()]
        .filter(channel => channel.open)
        .map(channel => ({
          name: channel.name,
          mode: channel.mode,
          open: channel.open,
          startedAt: channel.startedAt,
          endsAt: channel.endsAt,
          submissions: new Map(
            [...channel.submissions.entries()].map(([userId, submission]) => [
              userId,
              {
                input: structuredClone(submission.input),
                submittedAt: submission.submittedAt,
              },
            ]),
          ),
          claimedBy: [...channel.claimedBy],
          complete: channel.complete,
        })),
      leaderboard: buildLeaderboard(runtime.scoreState, runtime.gameDef.scoring),
    };
  }

  return {
    has(sessionId: string) {
      return activeRuntimes.has(sessionId);
    },

    get(sessionId: string) {
      const runtime = activeRuntimes.get(sessionId);
      return runtime ? toSnapshot(runtime) : null;
    },

    list() {
      return [...activeRuntimes.values()].map(toSnapshot);
    },

    async advancePhase(sessionId: string, input: GameEngineAdvancePhaseInput = {}) {
      const runtime = activeRuntimes.get(sessionId);
      if (!runtime) return null;

      if (!runtime.phaseState.currentPhase) {
        throw new Error('Active runtime is missing a current phase.');
      }

      const nextPhase =
        typeof input.nextPhase === 'string' && input.nextPhase.length > 0 ? input.nextPhase : null;
      if (nextPhase && !Object.hasOwn(runtime.gameDef.phases, nextPhase)) {
        throw new Error(`Unknown phase "${nextPhase}".`);
      }

      if (nextPhase) {
        runtime.phaseState.resolvedNext = nextPhase;
      }

      await advancePhase(runtime);
      return toSnapshot(runtime);
    },

    async submitInput(sessionId, input) {
      const runtime = activeRuntimes.get(sessionId);
      if (!runtime) return null;

      return processInputPipeline(runtime, input.channel, input.userId, input.data, input.sequence);
    },

    async mutate(sessionId, mutator) {
      const runtime = activeRuntimes.get(sessionId);
      if (!runtime) return null;

      const snapshot = toSnapshot(runtime);
      const ctx = refreshHandlerContext(runtime);
      const value = await mutator({
        snapshot,
        ctx,
        publishToSession(message) {
          runtime.publish(sessionRoom(runtime.sessionId), message);
        },
        publishToPlayer(userId, message) {
          runtime.publish(playerRoom(runtime.sessionId, userId), message);
        },
        publishToHost(message) {
          runtime.publish(hostRoom(runtime.sessionId), message);
        },
      });

      if (ctx.gameState !== runtime.gameState) {
        runtime.gameState = ctx.gameState;
      }

      for (const player of runtime.players.values()) {
        player.score = getScore(runtime.scoreState, player.userId);
      }

      refreshHandlerContext(runtime);
      return {
        value,
        snapshot: toSnapshot(runtime),
      };
    },
  };
}
