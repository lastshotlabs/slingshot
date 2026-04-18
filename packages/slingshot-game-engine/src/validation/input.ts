/**
 * Zod schemas for WS input message payload validation.
 *
 * These schemas validate client → server WS messages before they
 * enter the input pipeline. See spec §27.3 for message formats.
 *
 * @internal
 */
import { z } from 'zod';

/** Schema for `game:input` WS messages. */
export const GameInputMessageSchema = z.object({
  type: z.literal('game:input'),
  sessionId: z.string().min(1).describe('Target session ID.'),
  channel: z.string().min(1).describe('Target channel name.'),
  data: z.unknown().describe('Channel-specific input payload.'),
  sequence: z
    .number()
    .int()
    .nonnegative()
    .describe('Monotonically increasing sequence number per session per client.'),
});

/** Schema for `game:subscribe` WS messages. */
export const GameSubscribeMessageSchema = z.object({
  type: z.literal('game:subscribe'),
  sessionId: z.string().min(1).describe('Session to subscribe to.'),
});

/** Schema for `game:reconnect` WS messages. */
export const GameReconnectMessageSchema = z.object({
  type: z.literal('game:reconnect'),
  sessionId: z.string().min(1).describe('Session to reconnect to.'),
});

/** Schema for `game:unsubscribe` WS messages. */
export const GameUnsubscribeMessageSchema = z.object({
  type: z.literal('game:unsubscribe'),
  sessionId: z.string().min(1).describe('Session to unsubscribe from.'),
});

/** Schema for `game:stream.subscribe` WS messages. */
export const GameStreamSubscribeMessageSchema = z.object({
  type: z.literal('game:stream.subscribe'),
  sessionId: z.string().min(1).describe('Target session ID.'),
  channel: z.string().min(1).describe('Stream channel name.'),
});

/** Schema for `game:stream.unsubscribe` WS messages. */
export const GameStreamUnsubscribeMessageSchema = z.object({
  type: z.literal('game:stream.unsubscribe'),
  sessionId: z.string().min(1).describe('Target session ID.'),
  channel: z.string().min(1).describe('Stream channel name.'),
});

/**
 * Discriminated union of all client → server message schemas.
 * Used by the WS incoming dispatch to validate and route messages.
 */
export const ClientToServerMessageSchema = z.discriminatedUnion('type', [
  GameInputMessageSchema,
  GameSubscribeMessageSchema,
  GameReconnectMessageSchema,
  GameUnsubscribeMessageSchema,
  GameStreamSubscribeMessageSchema,
  GameStreamUnsubscribeMessageSchema,
]);

export type ValidatedGameInput = z.output<typeof GameInputMessageSchema>;
