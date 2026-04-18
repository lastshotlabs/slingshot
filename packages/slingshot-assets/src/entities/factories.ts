import type { PaginatedResult, RepoFactories, StoreInfra } from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import type { AssetAdapter, Asset as AssetRecord } from '../types';
import { Asset, assetOperations } from './asset';

/**
 * Default TTL for asset records, in seconds.
 */
export const DEFAULT_ASSET_REGISTRY_TTL_SECONDS = 30 * 24 * 60 * 60;

const baseAssetFactories = createEntityFactories(Asset, assetOperations.operations);

function isExpired(asset: AssetRecord, ttlSeconds: number): boolean {
  const createdAtMs = Date.parse(asset.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return Date.now() - createdAtMs > ttlSeconds * 1000;
}

async function deleteExpired(adapter: AssetAdapter, asset: AssetRecord): Promise<void> {
  await adapter.delete(asset.id);
}

async function readWithTtl(
  adapter: AssetAdapter,
  ttlSeconds: number,
  loader: () => Promise<AssetRecord | null>,
): Promise<AssetRecord | null> {
  const asset = await loader();
  if (!asset) return null;
  if (!isExpired(asset, ttlSeconds)) return asset;

  await deleteExpired(adapter, asset);
  return null;
}

async function filterPageWithTtl(
  adapter: AssetAdapter,
  ttlSeconds: number,
  page: PaginatedResult<AssetRecord>,
): Promise<PaginatedResult<AssetRecord>> {
  const kept: AssetRecord[] = [];
  const expired: AssetRecord[] = [];

  for (const asset of page.items) {
    if (isExpired(asset, ttlSeconds)) {
      expired.push(asset);
    } else {
      kept.push(asset);
    }
  }

  for (const asset of expired) {
    await deleteExpired(adapter, asset);
  }

  return {
    ...page,
    items: kept,
    hasMore: expired.length > 0 ? page.hasMore || page.items.length > kept.length : page.hasMore,
  };
}

/**
 * Wrap an asset adapter with lazy TTL enforcement.
 *
 * Expired records are treated as missing and are deleted on read.
 *
 * @param adapter - Base asset adapter.
 * @param ttlSeconds - Record lifetime in seconds.
 * @returns TTL-aware asset adapter wrapper.
 */
export function withAssetTtl(adapter: AssetAdapter, ttlSeconds: number): AssetAdapter {
  return {
    ...adapter,

    async getById(id) {
      return readWithTtl(adapter, ttlSeconds, async () => adapter.getById(id));
    },

    async list(params) {
      return filterPageWithTtl(adapter, ttlSeconds, await adapter.list(params));
    },

    async update(id, input) {
      const existing = await readWithTtl(adapter, ttlSeconds, async () => adapter.getById(id));
      if (!existing) return null;
      return adapter.update(id, input);
    },

    async listByOwner(params) {
      return filterPageWithTtl(adapter, ttlSeconds, await adapter.listByOwner(params));
    },

    async existsByKey(params) {
      const asset = await readWithTtl(adapter, ttlSeconds, async () => adapter.findByKey(params));
      return asset !== null;
    },

    async findByKey(params) {
      return readWithTtl(adapter, ttlSeconds, async () => adapter.findByKey(params));
    },
  };
}

function buildFactory<K extends keyof RepoFactories<AssetAdapter>>(
  key: K,
  ttlSeconds: number,
): RepoFactories<AssetAdapter>[K] {
  return ((infra: StoreInfra) => {
    const baseFactory = baseAssetFactories[key] as (context: StoreInfra) => AssetAdapter;
    return withAssetTtl(baseFactory(infra), ttlSeconds);
  }) as RepoFactories<AssetAdapter>[K];
}

/**
 * Create the `RepoFactories` map for the `Asset` entity.
 *
 * Each resolved adapter instance is wrapped with lazy TTL enforcement so expired asset
 * records behave like missing records across all backends.
 *
 * @param ttlSeconds - Asset record TTL in seconds.
 * @returns Repo factory map for memory, redis, sqlite, mongo, and postgres backends.
 */
export function createAssetFactories(
  ttlSeconds = DEFAULT_ASSET_REGISTRY_TTL_SECONDS,
): RepoFactories<AssetAdapter> {
  return {
    memory: buildFactory('memory', ttlSeconds),
    redis: buildFactory('redis', ttlSeconds),
    sqlite: buildFactory('sqlite', ttlSeconds),
    mongo: buildFactory('mongo', ttlSeconds),
    postgres: buildFactory('postgres', ttlSeconds),
  };
}
