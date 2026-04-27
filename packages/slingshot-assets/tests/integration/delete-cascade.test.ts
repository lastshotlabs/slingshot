import { describe, expect, it, spyOn } from 'bun:test';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { createAssetsTestApp, seedAsset } from '../../src/testing';

function createDeleteTrackingStorage() {
  const deletedKeys: string[] = [];
  const storage: StorageAdapter = {
    async put() {
      return {};
    },
    async get() {
      return null;
    },
    async delete(key) {
      deletedKeys.push(key);
    },
  };
  return { storage, deletedKeys };
}

describe('asset delete cascade', () => {
  it('deletes the storage file after deleting the asset record', async () => {
    const { storage, deletedKeys } = createDeleteTrackingStorage();
    const { app, state } = await createAssetsTestApp({ storage });
    const asset = await seedAsset(state, {
      key: 'uploads/test-delete.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    const response = await app.request(`/assets/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });

    expect(response.status).toBe(204);
    expect(deletedKeys).toEqual(['uploads/test-delete.png']);
    expect(await state.assets.getById(asset.id)).toBeNull();
  });

  it('does not delete the storage file for a non-owner', async () => {
    const { storage, deletedKeys } = createDeleteTrackingStorage();
    const { app, state } = await createAssetsTestApp({ storage });
    const asset = await seedAsset(state, {
      key: 'uploads/test-forbidden.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    const response = await app.request(`/assets/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-2' },
    });

    expect(response.status).toBe(404);
    expect(deletedKeys).toHaveLength(0);
    expect(await state.assets.getById(asset.id)).not.toBeNull();
  });

  it('returns 204 even when storage.delete() throws — error is logged, not propagated', async () => {
    const storage: StorageAdapter = {
      async put() {
        return {};
      },
      async get() {
        return null;
      },
      async delete() {
        throw new Error('storage unavailable');
      },
    };
    const { app, state } = await createAssetsTestApp({ storage });
    const asset = await seedAsset(state, {
      key: 'uploads/failing-delete.png',
      ownerUserId: 'user-1',
      mimeType: 'image/png',
    });

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.request(`/assets/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': 'user-1' },
    });
    errorSpy.mockRestore();

    expect(response.status).toBe(204);
    expect(await state.assets.getById(asset.id)).toBeNull();
  });
});
