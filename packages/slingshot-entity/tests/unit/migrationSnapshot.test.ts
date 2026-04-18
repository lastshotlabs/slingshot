/**
 * Snapshot save/load cycle tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { defineEntity, field } from '../../src/index';
import { loadSnapshot, saveSnapshot } from '../../src/migrations/snapshotStore';

const TMP_DIR = join(import.meta.dir, '../.tmp-snapshot-test');

const UserEntity = defineEntity('User', {
  namespace: 'accounts',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    email: field.string(),
    createdAt: field.date({ default: 'now' }),
  },
});

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe('loadSnapshot', () => {
  it('returns null when no snapshot exists', () => {
    const result = loadSnapshot(TMP_DIR, UserEntity);
    expect(result).toBeNull();
  });

  it('returns the saved snapshot after saveSnapshot is called', () => {
    saveSnapshot(TMP_DIR, UserEntity);
    const snapshot = loadSnapshot(TMP_DIR, UserEntity);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.snapshotVersion).toBe(1);
    expect(snapshot!.entity.name).toBe('User');
    expect(snapshot!.entity._storageName).toBe(UserEntity._storageName);
  });

  it('snapshot contains all entity fields', () => {
    saveSnapshot(TMP_DIR, UserEntity);
    const snapshot = loadSnapshot(TMP_DIR, UserEntity);
    expect(snapshot!.entity.fields).toMatchObject({
      id: expect.objectContaining({ type: 'string', primary: true }),
      email: expect.objectContaining({ type: 'string' }),
      createdAt: expect.objectContaining({ type: 'date' }),
    });
  });

  it('snapshot has a valid ISO timestamp', () => {
    saveSnapshot(TMP_DIR, UserEntity);
    const snapshot = loadSnapshot(TMP_DIR, UserEntity);
    const ts = Date.parse(snapshot!.timestamp);
    expect(Number.isNaN(ts)).toBe(false);
  });
});

describe('saveSnapshot', () => {
  it('creates the snapshot directory if it does not exist', () => {
    const nestedDir = join(TMP_DIR, 'nested', 'snapshots');
    expect(existsSync(nestedDir)).toBe(false);
    saveSnapshot(nestedDir, UserEntity);
    expect(existsSync(nestedDir)).toBe(true);
  });

  it('overwrites the previous snapshot on subsequent saves', () => {
    const PostV1 = defineEntity('Post', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        title: field.string(),
      },
    });

    const PostV2 = defineEntity('Post', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        title: field.string(),
        body: field.string({ optional: true }),
      },
    });

    saveSnapshot(TMP_DIR, PostV1);
    const snap1 = loadSnapshot(TMP_DIR, PostV1);
    expect(Object.keys(snap1!.entity.fields)).not.toContain('body');

    saveSnapshot(TMP_DIR, PostV2);
    const snap2 = loadSnapshot(TMP_DIR, PostV2);
    expect(Object.keys(snap2!.entity.fields)).toContain('body');
  });

  it('stores separate snapshots for distinct entities', () => {
    const Alpha = defineEntity('Alpha', {
      fields: { id: field.string({ primary: true }), value: field.string() },
    });
    const Beta = defineEntity('Beta', {
      fields: { id: field.integer({ primary: true }), label: field.string() },
    });

    saveSnapshot(TMP_DIR, Alpha);
    saveSnapshot(TMP_DIR, Beta);

    const snapAlpha = loadSnapshot(TMP_DIR, Alpha);
    const snapBeta = loadSnapshot(TMP_DIR, Beta);

    expect(snapAlpha!.entity.name).toBe('Alpha');
    expect(snapBeta!.entity.name).toBe('Beta');
  });
});
