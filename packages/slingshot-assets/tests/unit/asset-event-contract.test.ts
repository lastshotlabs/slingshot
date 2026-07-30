import { describe, expect, test } from 'bun:test';
import { Asset } from '../../src/entities/asset';

describe('asset lifecycle event contracts', () => {
  test('created and deleted events carry fields needed for per-owner byte aggregates', () => {
    expect(Asset.routes?.create?.event?.payload).toEqual([
      'id',
      'key',
      'ownerUserId',
      'mimeType',
      'size',
    ]);
    expect(Asset.routes?.delete?.event?.payload).toEqual(['id', 'key', 'ownerUserId', 'size']);
  });
});
