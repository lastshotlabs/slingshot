import { describe, expect, test } from 'bun:test';
import { Asset } from '../../src/entities/asset';

describe('asset lifecycle event contracts', () => {
  test('created and deleted events carry fields needed for per-owner byte aggregates', () => {
    const createdEvent = Asset.routes?.create?.event;
    const deletedEvent = Asset.routes?.delete?.event;

    expect(typeof createdEvent).toBe('object');
    expect(typeof deletedEvent).toBe('object');
    if (typeof createdEvent !== 'object' || typeof deletedEvent !== 'object') {
      throw new Error('asset lifecycle events must use structured event declarations');
    }

    expect(createdEvent.payload).toEqual(['id', 'key', 'ownerUserId', 'mimeType', 'size']);
    expect(deletedEvent.payload).toEqual(['id', 'key', 'ownerUserId', 'size']);
  });
});
