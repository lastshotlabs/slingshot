import { describe, expect, mock, spyOn, test } from 'bun:test';
import { createDeleteStorageFileMiddleware } from '../../src/middleware/deleteStorageFile';
import type { Asset, AssetAdapter } from '../../src/types';

function makeAsset(id = 'asset-1'): Asset {
  return {
    id,
    key: `uploads/${id}.txt`,
    ownerUserId: 'user-1',
    tenantId: null,
    mimeType: 'text/plain',
    size: 12,
    bucket: null,
    originalName: `${id}.txt`,
    createdAt: new Date().toISOString(),
  };
}

function makeContext(id: string | undefined, status = 204) {
  return {
    req: {
      param(name: string) {
        return name === 'id' ? id : undefined;
      },
    },
    res: { status },
  };
}

function makeAssetAdapter(asset: Asset | null): AssetAdapter {
  return {
    create: mock(async input => ({ ...makeAsset(String(input.id ?? 'asset-new')), ...input })),
    getById: mock(async () => asset),
    list: mock(async () => ({ items: asset ? [asset] : [], hasMore: false })),
    update: mock(async () => asset),
    delete: mock(async () => true),
    clear: mock(async () => {}),
    listByOwner: mock(async () => ({ items: asset ? [asset] : [], hasMore: false })),
    existsByKey: mock(async () => asset !== null),
    findByKey: mock(async () => asset),
  };
}

describe('createDeleteStorageFileMiddleware', () => {
  test('deletes the backing storage key after a successful asset delete', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {});
    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
    });
    const next = mock(async () => {});

    await middleware(makeContext(asset.id) as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith(asset.key);
  });

  test('skips cleanup when the asset is missing, id is absent, or response is non-success', async () => {
    const storageDelete = mock(async () => {});
    const storage = {
      async put() {
        return {};
      },
      async get() {
        return null;
      },
      delete: storageDelete,
    };

    await createDeleteStorageFileMiddleware({
      storage,
      assetAdapter: makeAssetAdapter(null),
    })(makeContext('missing') as never, mock(async () => {}));

    await createDeleteStorageFileMiddleware({
      storage,
      assetAdapter: makeAssetAdapter(makeAsset()),
    })(makeContext(undefined) as never, mock(async () => {}));

    await createDeleteStorageFileMiddleware({
      storage,
      assetAdapter: makeAssetAdapter(makeAsset()),
    })(makeContext('asset-1', 404) as never, mock(async () => {}));

    expect(storageDelete).not.toHaveBeenCalled();
  });

  test('retries transient storage delete failures before succeeding', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      if (storageDelete.mock.calls.length === 1) {
        throw new Error('temporary storage outage');
      }
    });
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === 'function') handler();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    try {
      const middleware = createDeleteStorageFileMiddleware({
        storage: {
          async put() {
            return {};
          },
          async get() {
            return null;
          },
          delete: storageDelete,
        },
        assetAdapter: makeAssetAdapter(asset),
        retryAttempts: 2,
      });

      await middleware(makeContext(asset.id) as never, mock(async () => {}));
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(storageDelete).toHaveBeenCalledTimes(2);
  });

  test('logs orphaned storage objects after delete retries are exhausted', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('permanent storage outage');
    });
    const error = spyOn(console, 'error').mockImplementation(() => {});

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
    });

    try {
      await middleware(makeContext(asset.id) as never, mock(async () => {}));

      expect(storageDelete).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('ORPHANED storage object'),
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });
});
