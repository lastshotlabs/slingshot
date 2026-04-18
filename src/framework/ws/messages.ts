// ---------------------------------------------------------------------------
// WS Messages — thin wrappers that consume repositories from context
// ---------------------------------------------------------------------------
import type {
  RoomPersistenceConfig,
  StoredMessage,
  WsMessageDefaults,
} from '@lastshotlabs/slingshot-core';
import { getContext } from '@lastshotlabs/slingshot-core';

export type { StoredMessage, WsMessageDefaults, RoomPersistenceConfig };

// ---------------------------------------------------------------------------
// Public API — requires app context
// ---------------------------------------------------------------------------

/**
 * Persist a message to a room. Returns null if room is not configured for persistence.
 * On store errors, logs a warning and returns null (non-blocking).
 */
export const persistMessage = async (
  endpoint: string,
  room: string,
  data: { senderId?: string | null; payload: unknown },
  app: object,
): Promise<StoredMessage | null> => {
  const ctx = getContext(app);
  const persistence = ctx.persistence;
  const config = persistence.getRoomConfig(endpoint, room);
  if (!config) return null;

  const message: StoredMessage = {
    id: crypto.randomUUID(),
    endpoint,
    room,
    senderId: data.senderId ?? null,
    payload: data.payload,
    createdAt: Date.now(),
  };

  try {
    return await persistence.wsMessages.persist(message, config);
  } catch (err) {
    console.warn(`[wsMessages] failed to persist message to ${endpoint}${room}:`, err);
    return null;
  }
};

/**
 * Get message history for a room.
 * Cursor-based pagination using message `id` as cursor.
 */
export const getMessageHistory = async (
  endpoint: string,
  room: string,
  opts: { limit?: number; before?: string; after?: string } | undefined,
  app: object,
): Promise<StoredMessage[]> => {
  return getContext(app).persistence.wsMessages.getHistory(endpoint, room, opts);
};

/**
 * Opt a room into message persistence.
 * Delegates to persistence.configureRoom() on the context.
 */
export const configureRoom = (
  endpoint: string,
  room: string,
  options: RoomPersistenceConfig,
  app: object,
): void => {
  const ctx = getContext(app);
  ctx.persistence.configureRoom(endpoint, room, options);
};
