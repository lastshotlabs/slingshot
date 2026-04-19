import { describe, expect, test } from 'bun:test';
import { MAX_CONTENT_BODY_LENGTH } from '@lastshotlabs/slingshot-core';
import {
  ChatRepoNotImplementedError,
  CHAT_PLUGIN_STATE_KEY,
  chatManifest,
  createChatPlugin,
} from '../../src/index';
import * as entry from '../../src/index';
import {
  createMessageSchema,
  createRoomSchema,
  updateRoomSchema,
} from '../../src/schemas';

describe('slingshot-chat public api', () => {
  test('entrypoint re-exports the main runtime surface', () => {
    expect(entry.createChatPlugin).toBe(createChatPlugin);
    expect(entry.chatManifest).toBe(chatManifest);
    expect(entry.CHAT_PLUGIN_STATE_KEY).toBe(CHAT_PLUGIN_STATE_KEY);
    expect(entry.ChatRepoNotImplementedError).toBe(ChatRepoNotImplementedError);
  });

  test('ChatRepoNotImplementedError preserves a clear backend-specific message', () => {
    const error = new ChatRepoNotImplementedError('postgres', 'listMessages');

    expect(error.name).toBe('ChatRepoNotImplementedError');
    expect(error.message).toContain('postgres backend');
    expect(error.message).toContain('listMessages() not implemented');
  });

  test('chat schemas apply defaults and reject invalid payloads', () => {
    const room = createRoomSchema.parse({
      name: 'General',
      type: 'group',
    });
    expect(room.encrypted).toBe(false);

    const message = createMessageSchema.parse({
      roomId: 'room-1',
      body: 'hello',
    });
    expect(message.type).toBe('text');
    expect(message.format).toBe('markdown');
    expect(message.replyToId).toBeNull();
    expect(message.appMetadata).toBeNull();

    const updatedRoom = updateRoomSchema.parse({
      avatarUrl: null,
    });
    expect(updatedRoom.avatarUrl).toBeNull();

    const oversized = createMessageSchema.safeParse({
      roomId: 'room-1',
      body: 'x'.repeat(MAX_CONTENT_BODY_LENGTH + 1),
    });
    expect(oversized.success).toBe(false);
  });
});
