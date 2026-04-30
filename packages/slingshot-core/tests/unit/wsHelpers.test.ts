import { describe, expect, test } from 'bun:test';
import { isValidRoomName } from '../../src/wsHelpers';

describe('isValidRoomName', () => {
  test('accepts simple alphanumeric room name', () => {
    expect(isValidRoomName('room1')).toBe(true);
  });

  test('accepts entity channel convention: storageName:entityId:channelName', () => {
    expect(isValidRoomName('containers:abc123:live')).toBe(true);
  });

  test('accepts room names with dots', () => {
    expect(isValidRoomName('my.room.name')).toBe(true);
  });

  test('accepts room names with forward slashes', () => {
    expect(isValidRoomName('namespace/room')).toBe(true);
  });

  test('accepts room names with hyphens', () => {
    expect(isValidRoomName('my-room')).toBe(true);
  });

  test('accepts room names with underscores', () => {
    expect(isValidRoomName('my_room')).toBe(true);
  });

  test('accepts single character room name', () => {
    expect(isValidRoomName('a')).toBe(true);
  });

  test('accepts 128 character room name (maximum length)', () => {
    expect(isValidRoomName('a'.repeat(128))).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidRoomName('')).toBe(false);
  });

  test('rejects 129 character room name (exceeds max)', () => {
    expect(isValidRoomName('a'.repeat(129))).toBe(false);
  });

  test('rejects room name with spaces', () => {
    expect(isValidRoomName('bad room')).toBe(false);
  });

  test('rejects room name with special characters', () => {
    expect(isValidRoomName('bad!room')).toBe(false);
    expect(isValidRoomName('room@name')).toBe(false);
    expect(isValidRoomName('room#name')).toBe(false);
  });

  test('rejects room name with newlines', () => {
    expect(isValidRoomName('room\nname')).toBe(false);
  });

  test('rejects non-string input', () => {
    // TypeScript would catch this, but runtime guard should handle it
    expect(isValidRoomName(123 as unknown as string)).toBe(false);
    expect(isValidRoomName(null as unknown as string)).toBe(false);
    expect(isValidRoomName(undefined as unknown as string)).toBe(false);
  });

  test('accepts mixed valid characters', () => {
    expect(isValidRoomName('org:tenant-1/entity.channel_name')).toBe(true);
  });
});
