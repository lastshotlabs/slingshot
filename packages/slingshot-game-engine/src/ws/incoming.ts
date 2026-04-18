/**
 * WS incoming handlers for the game engine.
 *
 * Defines handlers for all client → server game messages:
 * `game:input`, `game:subscribe`, `game:reconnect`, `game:unsubscribe`,
 * `game:stream.subscribe`, `game:stream.unsubscribe`.
 *
 * See spec §27.3 for message formats and §12.1 for the input pipeline.
 */
import { GameErrorCode } from '../errors';
import { getPlayerRooms, playerRoom, sessionRoom, streamRoom } from '../lib/display';
import type { GameDefinition, GamePlayerState } from '../types/models';
import {
  GameInputMessageSchema,
  GameReconnectMessageSchema,
  GameStreamSubscribeMessageSchema,
  GameStreamUnsubscribeMessageSchema,
  GameSubscribeMessageSchema,
  GameUnsubscribeMessageSchema,
} from '../validation/input';

/** Shape of a single incoming WS event handler. */
export interface IncomingHandler {
  event: string;
  handler: (ctx: IncomingHandlerContext) => void | Promise<void>;
}

/** Context passed to each incoming handler. */
export interface IncomingHandlerContext {
  /** Authenticated user ID. */
  userId: string;
  /** Socket ID for sender identification. */
  socketId: string;
  /** Raw event payload from the client. */
  payload: unknown;
  /** Send an ack/response to the sender only. */
  ack(data: unknown): void;
  /** Publish a message to a WS room. */
  publish(room: string, data: unknown): void;
  /** Subscribe this socket to a room. */
  subscribe(room: string): void;
  /** Unsubscribe this socket from a room. */
  unsubscribe(room: string): void;
}

/** Dependencies for building incoming dispatch handlers. */
export interface IncomingDispatchDeps {
  /**
   * Resolve a session by ID.
   * Returns session state with status, players, etc.
   */
  resolveSession(sessionId: string): Promise<{
    session: { id: string; gameType: string; status: string; hostUserId: string };
    players: GamePlayerState[];
    gameDef: GameDefinition;
  } | null>;

  /**
   * Process a game input through the full input pipeline.
   * Returns the InputAck to send back to the client.
   */
  processInput(
    sessionId: string,
    channel: string,
    userId: string,
    data: unknown,
    sequence: number,
  ): Promise<{
    accepted: boolean;
    code?: string;
    reason?: string;
    data?: unknown;
    details?: unknown;
  }>;

  /**
   * Handle player reconnection (restore state, cancel grace timer, etc.).
   */
  handleReconnect(
    sessionId: string,
    userId: string,
    subscribe: (room: string) => void,
    ack: (data: unknown) => void,
    publish: (room: string, data: unknown) => void,
  ): Promise<void>;

  /** Event bus for emitting game events. */
  bus: {
    emit(event: string, data: unknown): void;
  };
}

/**
 * Build the array of incoming WS handlers for the game engine.
 *
 * Each handler validates the message payload, resolves session state,
 * and dispatches to the appropriate pipeline.
 */
export function buildIncomingDispatch(deps: IncomingDispatchDeps): IncomingHandler[] {
  return [
    // ── game:subscribe ─────────────────────────────────────────
    {
      event: 'game:subscribe',
      async handler(ctx) {
        const parsed = GameSubscribeMessageSchema.safeParse(ctx.payload);
        if (!parsed.success) {
          ctx.ack({
            type: 'game:error',
            sessionId: '',
            code: GameErrorCode.INPUT_VALIDATION_FAILED,
            message: 'Invalid subscribe message.',
          });
          return;
        }

        const { sessionId } = parsed.data;
        const resolved = await deps.resolveSession(sessionId);
        if (!resolved) {
          ctx.ack({
            type: 'game:error',
            sessionId,
            code: GameErrorCode.SESSION_NOT_FOUND,
            message: 'Session not found.',
          });
          return;
        }

        const { session, players } = resolved;
        const player = players.find(p => p.userId === ctx.userId);

        if (!player) {
          ctx.ack({
            type: 'game:error',
            sessionId,
            code: GameErrorCode.PLAYER_NOT_IN_SESSION,
            message: 'You are not a player in this session.',
          });
          return;
        }

        // Subscribe to all appropriate rooms
        const rooms = getPlayerRooms(sessionId, player);
        for (const room of rooms) {
          ctx.subscribe(room);
        }

        // Send state snapshot
        ctx.ack({
          type: 'game:state.snapshot',
          sessionId,
          session: {
            id: session.id,
            gameType: session.gameType,
            status: session.status,
            hostUserId: session.hostUserId,
          },
          players: players.map(p => ({
            userId: p.userId,
            displayName: p.displayName,
            role: p.role,
            team: p.team,
            playerState: p.playerState,
            score: p.score,
            connected: p.connected,
            isHost: p.isHost,
            isSpectator: p.isSpectator,
          })),
        });
      },
    },

    // ── game:reconnect ─────────────────────────────────────────
    {
      event: 'game:reconnect',
      async handler(ctx) {
        const parsed = GameReconnectMessageSchema.safeParse(ctx.payload);
        if (!parsed.success) {
          ctx.ack({
            type: 'game:error',
            sessionId: '',
            code: GameErrorCode.INPUT_VALIDATION_FAILED,
            message: 'Invalid reconnect message.',
          });
          return;
        }

        const { sessionId } = parsed.data;
        const resolved = await deps.resolveSession(sessionId);
        if (!resolved) {
          ctx.ack({
            type: 'game:error',
            sessionId,
            code: GameErrorCode.SESSION_NOT_FOUND,
            message: 'Session not found.',
          });
          return;
        }

        const { session, players } = resolved;
        const player = players.find(p => p.userId === ctx.userId);

        if (!player) {
          ctx.ack({
            type: 'game:error',
            sessionId,
            code: GameErrorCode.PLAYER_NOT_IN_SESSION,
            message: 'You are not a player in this session.',
          });
          return;
        }

        // Check session is not completed/abandoned
        if (session.status === 'completed' || session.status === 'abandoned') {
          ctx.ack({
            type: 'game:error',
            sessionId,
            code:
              session.status === 'completed'
                ? GameErrorCode.SESSION_COMPLETED
                : GameErrorCode.SESSION_ABANDONED,
            message: `Session is ${session.status}.`,
          });
          return;
        }

        await deps.handleReconnect(
          sessionId,
          ctx.userId,
          (room: string) => ctx.subscribe(room),
          (data: unknown) => ctx.ack(data),
          (room: string, data: unknown) => ctx.publish(room, data),
        );
      },
    },

    // ── game:unsubscribe ───────────────────────────────────────
    {
      event: 'game:unsubscribe',
      handler(ctx) {
        const parsed = GameUnsubscribeMessageSchema.safeParse(ctx.payload);
        if (!parsed.success) return;

        const { sessionId } = parsed.data;

        // Unsubscribe from all session rooms
        ctx.unsubscribe(sessionRoom(sessionId));
        ctx.unsubscribe(playerRoom(sessionId, ctx.userId));
      },
    },

    // ── game:input ─────────────────────────────────────────────
    {
      event: 'game:input',
      async handler(ctx) {
        const parsed = GameInputMessageSchema.safeParse(ctx.payload);
        if (!parsed.success) {
          ctx.ack({
            type: 'game:input.ack',
            sessionId: '',
            channel: '',
            sequence: 0,
            accepted: false,
            code: GameErrorCode.INPUT_VALIDATION_FAILED,
            reason: 'Invalid input message format.',
          });
          return;
        }

        const { sessionId, channel, data, sequence } = parsed.data;

        const result = await deps.processInput(sessionId, channel, ctx.userId, data, sequence);

        // Send input ack to the sender
        ctx.ack({
          type: 'game:input.ack',
          sessionId,
          channel,
          sequence,
          accepted: result.accepted,
          ...(result.code && { code: result.code }),
          ...(result.reason && { reason: result.reason }),
          ...(result.data !== undefined && { data: result.data }),
          ...(result.details !== undefined && { details: result.details }),
        });
      },
    },

    // ── game:stream.subscribe ──────────────────────────────────
    {
      event: 'game:stream.subscribe',
      handler(ctx) {
        const parsed = GameStreamSubscribeMessageSchema.safeParse(ctx.payload);
        if (!parsed.success) return;

        const { sessionId, channel } = parsed.data;
        ctx.subscribe(streamRoom(sessionId, channel));
      },
    },

    // ── game:stream.unsubscribe ────────────────────────────────
    {
      event: 'game:stream.unsubscribe',
      handler(ctx) {
        const parsed = GameStreamUnsubscribeMessageSchema.safeParse(ctx.payload);
        if (!parsed.success) return;

        const { sessionId, channel } = parsed.data;
        ctx.unsubscribe(streamRoom(sessionId, channel));
      },
    },
  ];
}
