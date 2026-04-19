/**
 * Coverage tests for src/framework/upload/registry.ts
 *
 * Targets uncovered lines 37-38: the deleteUploadRecord function.
 */
import { describe, expect, test } from 'bun:test';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import { deleteUploadRecord, registerUpload, getUploadRecord } from '../../src/framework/upload/registry';

function makeApp(records?: Map<string, unknown>) {
  const store = records ?? new Map<string, unknown>();
  const app = createRouter();
  const ctx = {
    app,
    config: {},
    persistence: {
      uploadRegistry: {
        register: async (record: { key: string }) => {
          store.set(record.key, record);
        },
        get: async (key: string) => store.get(key) ?? null,
        delete: async (key: string) => store.delete(key),
      },
    },
  } as any;
  attachContext(app, ctx);
  return { app, store };
}

describe('deleteUploadRecord', () => {
  test('returns true when the key existed', async () => {
    const { app, store } = makeApp();
    store.set('file-a.png', { key: 'file-a.png', createdAt: Date.now() });

    const result = await deleteUploadRecord('file-a.png', app);
    expect(result).toBe(true);
    expect(store.has('file-a.png')).toBe(false);
  });

  test('returns false when the key did not exist', async () => {
    const { app } = makeApp();
    const result = await deleteUploadRecord('nonexistent.txt', app);
    expect(result).toBe(false);
  });

  test('works with the full register/get/delete lifecycle', async () => {
    const { app } = makeApp();
    const record = { key: 'lifecycle.txt', ownerUserId: 'u1', createdAt: Date.now() };

    await registerUpload(record as any, app);
    const found = await getUploadRecord('lifecycle.txt', app);
    expect(found).not.toBeNull();
    expect((found as any).key).toBe('lifecycle.txt');

    const deleted = await deleteUploadRecord('lifecycle.txt', app);
    expect(deleted).toBe(true);

    const afterDelete = await getUploadRecord('lifecycle.txt', app);
    expect(afterDelete).toBeNull();
  });
});
