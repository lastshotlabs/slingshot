import type { WsState } from '@lastshotlabs/slingshot-core';
import { wsEndpointKey } from './namespace';

export const trackSocket = (state: WsState, socketId: string, userId: string | null): void => {
  if (!userId) return;
  state.socketUsers.set(socketId, userId);
};

export const untrackSocket = (state: WsState, socketId: string): void => {
  state.socketUsers.delete(socketId);
};

export const addPresence = (
  state: WsState,
  socketId: string,
  endpoint: string,
  room: string,
): { userId: string; isNewUser: boolean } | null => {
  const userId = state.socketUsers.get(socketId);
  if (!userId) return null;

  const key = wsEndpointKey(endpoint, room);
  let roomMap = state.roomPresence.get(key);
  if (!roomMap) {
    roomMap = new Map();
    state.roomPresence.set(key, roomMap);
  }

  // Get-or-create in a single pass — avoids the double has()/get() pattern which
  // would re-evaluate membership between the check and the add.
  const existingSockets = roomMap.get(userId);
  const isNewUser = !existingSockets || existingSockets.size === 0;
  const sockets = existingSockets ?? new Set<string>();
  if (!existingSockets) roomMap.set(userId, sockets);
  sockets.add(socketId);

  return { userId, isNewUser };
};

export const removePresence = (
  state: WsState,
  socketId: string,
  endpoint: string,
  room: string,
): { userId: string; isLastSocket: boolean } | null => {
  const userId = state.socketUsers.get(socketId);
  if (!userId) return null;

  const key = wsEndpointKey(endpoint, room);
  const roomMap = state.roomPresence.get(key);
  if (!roomMap) return null;

  const sockets = roomMap.get(userId);
  if (!sockets) return null;

  sockets.delete(socketId);
  const isLastSocket = sockets.size === 0;
  if (isLastSocket) {
    roomMap.delete(userId);
    if (roomMap.size === 0) state.roomPresence.delete(key);
  }

  return { userId, isLastSocket };
};

export const cleanupPresence = (
  state: WsState,
  socketId: string,
  endpoint: string,
  rooms: Set<string>,
): Array<{ room: string; userId: string }> => {
  const userId = state.socketUsers.get(socketId);
  if (!userId) return [];

  const departed: Array<{ room: string; userId: string }> = [];

  for (const room of rooms) {
    const key = wsEndpointKey(endpoint, room);
    const roomMap = state.roomPresence.get(key);
    if (!roomMap) continue;

    const sockets = roomMap.get(userId);
    if (!sockets) continue;

    sockets.delete(socketId);
    if (sockets.size === 0) {
      roomMap.delete(userId);
      if (roomMap.size === 0) state.roomPresence.delete(key);
      departed.push({ room, userId });
    }
  }

  return departed;
};

export const getRoomPresence = (state: WsState, endpoint: string, room: string): string[] => {
  const roomMap = state.roomPresence.get(wsEndpointKey(endpoint, room));
  if (!roomMap) return [];
  return [...roomMap.keys()];
};

export const getUserPresence = (state: WsState, userId: string): string[] => {
  const rooms: string[] = [];
  for (const [key, roomMap] of state.roomPresence) {
    const sockets = roomMap.get(userId);
    if (sockets && sockets.size > 0) {
      const colonIdx = key.indexOf(':');
      if (colonIdx !== -1) rooms.push(decodeURIComponent(key.slice(colonIdx + 1)));
    }
  }
  return rooms;
};
