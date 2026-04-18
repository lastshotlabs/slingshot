// packages/slingshot-chat/src/ws/incoming.ts
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import { now } from '../lib/utils';
import type {
  ChatPingPayload,
  ChatPluginState,
  ChatReadPayload,
  ChatTypingPayload,
  ReadReceiptCreatedPayload,
} from '../types';

/**
 * Shape of a single incoming WS event handler entry.
 *
 * Matches the `receive` config pattern from slingshot-entity's ws-presence-typing feature.
 * The `event` string must match exactly what the client sends in the `event` field.
 *
 * Client sends: `{ action: 'event', event: 'chat.typing', payload: { roomId: '...' }, ackId?: '...' }`
 * @internal
 */
export interface IncomingHandler {
  /** The event name from the client message. */
  event: string;
  /** Handler invoked when this event arrives. */
  handler: (ctx: IncomingHandlerContext) => void | Promise<void>;
}

/**
 * Context passed to each incoming WS event handler.
 *
 * Provided by the slingshot-entity WS layer when dispatching a typed event.
 * @internal
 */
export interface IncomingHandlerContext {
  /** Authenticated user ID from the WS session. */
  userId: string;
  /** Socket/connection ID of the sender. Used for excluding sender from broadcasts. */
  socketId: string;
  /** The room ID extracted from the channel URL parameter. */
  roomId: string;
  /** The parsed event payload from the client. */
  payload: unknown;
  /**
   * Acknowledge the event. Only call when the client provided an `ackId`.
   * Sends `{ ackId, data }` back to the sender only.
   */
  ack?: (data: unknown) => void;
  /**
   * Publish a message to the WS room.
   * `volatile: true` skips buffering — appropriate for typing indicators.
   * `exclude` is a Set of socketIds to skip.
   */
  publish: (
    room: string,
    event: string,
    data: unknown,
    opts?: { volatile?: boolean; exclude?: Set<string> },
  ) => void;
}

/**
 * Build the typed incoming WS dispatch handlers for the message channel.
 *
 * Returns an array of `IncomingHandler` entries registered as incoming
 * handlers on the `chat` WS endpoint during the plugin's `setupPost` phase.
 *
 * Handlers:
 * - `chat.typing` — volatile broadcast to room, excluding sender
 * - `chat.read`   — record read receipt, update lastReadAt, broadcast to room
 * - `chat.ping`   — respond with `chat.pong` to sender only
 *
 * @param state - The ChatPluginState.
 * @param bus   - The SlingshotEventBus (or compatible emitter) for emitting cross-plugin events.
 * @internal
 */
export function buildIncomingDispatch(
  state: ChatPluginState,
  bus: Pick<SlingshotEventBus, 'emit'>,
): IncomingHandler[] {
  return [
    {
      /**
       * `chat.typing` — client is typing in a room.
       *
       * Flow:
       * 1. Validate payload (`roomId` required).
       * 2. Verify sender is a member of the room.
       * 3. Volatile-publish `chat.typing` to the room, excluding the sender.
       *    `volatile: true` means the event is NOT queued for disconnected clients.
       *    Typing indicators are ephemeral — no value in queuing.
       */
      event: 'chat.typing',
      handler: async (ctx: IncomingHandlerContext) => {
        const payload = ctx.payload as Partial<ChatTypingPayload>;
        const roomId = payload.roomId ?? ctx.roomId;
        if (!roomId) return;

        // Verify membership
        const member = await state.members.findMember({ roomId, userId: ctx.userId });
        if (!member) return;

        // Volatile broadcast — exclude sender
        ctx.publish(
          `messages:${roomId}:live`,
          'chat.typing',
          { userId: ctx.userId, roomId },
          { volatile: true, exclude: new Set([ctx.socketId]) },
        );
      },
    },

    {
      /**
       * `chat.read` — client acknowledges reading messages up to a given message ID.
       *
       * Flow:
       * 1. Validate payload (`roomId`, `messageId`).
       * 2. Verify sender is a member of the room.
       * 3. Upsert a `ReadReceipt` row.
       * 4. Update `RoomMember.lastReadAt`.
       * 5. Increment `Message.readBy`.
       * 6. Emit `chat:read.created` on the bus — the WS forward config picks this
       *    up and broadcasts `chat.read` to all room members.
       * 7. If `ackId` present, ack the sender with `{ ok: true }`.
       */
      event: 'chat.read',
      handler: async (ctx: IncomingHandlerContext) => {
        const payload = ctx.payload as Partial<ChatReadPayload>;
        const roomId = payload.roomId ?? ctx.roomId;
        const messageId = payload.messageId;
        if (!roomId || !messageId) return;

        const member = await state.members.findMember({ roomId, userId: ctx.userId });
        if (!member) return;

        // Verify the messageId actually belongs to this room.
        // Without this check, a forged payload could record read receipts and
        // increment readBy counts on messages from entirely different rooms.
        const msg = await state.messages.getById(messageId);
        if (!msg || msg.roomId !== roomId) {
          ctx.publish(
            `messages:${roomId}:live`,
            'chat.error',
            { message: 'Message not found in this room' },
            { volatile: true, exclude: new Set([ctx.socketId]) },
          );
          if (ctx.ack) ctx.ack({ ok: false, error: 'Message not found in this room' });
          return;
        }

        const readAt = now();

        // Check whether this user already has a receipt for this message BEFORE
        // upsert. incrementReadBy must only fire on the first read — not on every
        // subsequent chat.read event for the same message from the same user.
        const existingReceipts = await state.receipts.listByMessage({ messageId });
        const alreadyRead = existingReceipts.items.some(r => r.userId === ctx.userId);

        // Upsert receipt (idempotent — returns existing if already present)
        const receipt = await state.receipts.upsertReceipt({
          userId: ctx.userId,
          messageId,
          roomId,
          readAt,
        });

        // Update lastReadAt on membership
        await state.members.updateLastRead({ roomId, userId: ctx.userId }, { lastReadAt: readAt });

        // Only increment readBy count on the first read of this message by this user.
        if (!alreadyRead) {
          await state.messages.incrementReadBy({ id: messageId }, { readBy: msg.readBy + 1 });
        }

        // Emit on bus — WS forward picks up `chat:read.created` → `chat.read` client event
        const busPayload: ReadReceiptCreatedPayload & { messageId: string; readAt: string } = {
          receipt,
          roomId,
          userId: ctx.userId,
          messageId,
          readAt,
        };
        bus.emit('chat:read.created', busPayload);

        if (ctx.ack) ctx.ack({ ok: true, readAt });
      },
    },

    {
      /**
       * `chat.ping` — keepalive / round-trip latency measurement.
       *
       * Responds to the sender only with `chat.pong` containing the original timestamp.
       * Does not broadcast to the room.
       */
      event: 'chat.ping',
      handler: (ctx: IncomingHandlerContext) => {
        const payload = ctx.payload as Partial<ChatPingPayload>;
        if (ctx.ack) {
          ctx.ack({ ts: payload.ts ?? Date.now(), serverTs: Date.now() });
        }
        // If no ackId, a no-op. Ping without ack is fire-and-forget keepalive.
      },
    },
  ];
}
