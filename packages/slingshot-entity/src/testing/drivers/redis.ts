import { randomUUID } from 'node:crypto';
import type {
  EntityAdapter,
  EntityBackendProfile,
  OperationConfig,
  RedisLike,
  ResolvedEntityConfig,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import { createUnsupportedTransactionManager } from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, resolveEntityBackendRequirements } from '../../configDriven';
import { ENTITY_BACKEND_PROFILES } from '../../configDriven/backendProfiles';
import { storageName } from '../../lib/naming';
import type {
  EntityConformanceDefinition,
  EntityConformanceDriver,
  EntityConformanceHarness,
} from '../conformance';
import { CONFORMANCE_COMPOSITE_KEY, CONFORMANCE_COMPOSITE_OPERATIONS } from '../fixtures';

const DEFAULT_REDIS_URL = 'redis://localhost:6380';
const APP_NAME_PATTERN = /^entity-conformance-[0-9a-f]{32}$/;

type CompositeEntry = {
  readonly config: EntityConformanceDefinition['config'];
  readonly operations?: Record<string, OperationConfig>;
};

interface RedisResources {
  readonly client: import('ioredis').default;
  readonly composite: Readonly<Record<string, unknown>>;
  readonly cleanupPatterns: readonly string[];
}

function withoutUnsupportedUniqueness(config: ResolvedEntityConfig): ResolvedEntityConfig {
  return {
    ...config,
    uniques: [],
    indexes: (config.indexes ?? []).filter(index => !index.unique),
  };
}

function supportedOperations(
  profile: EntityBackendProfile,
  definition: EntityConformanceDefinition,
): Record<string, OperationConfig> | undefined {
  if (!definition.operations) return undefined;
  const selected: Record<string, OperationConfig> = {};
  for (const [name, operation] of Object.entries(definition.operations)) {
    const requirements = resolveEntityBackendRequirements(definition.config, { [name]: operation });
    if (
      requirements.every(
        requirement => profile.capabilities[requirement.capability].status === 'supported',
      )
    ) {
      selected[name] = operation;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function cleanupPattern(config: ResolvedEntityConfig, appName: string): string {
  const resolvedStorageName = storageName(config, 'redis');
  const customRedisKey = config._conventions?.redisKey;
  const pattern = customRedisKey
    ? customRedisKey({ appName, storageName: resolvedStorageName, pk: '*' })
    : `${resolvedStorageName}:${appName}:*`;
  if (
    !APP_NAME_PATTERN.test(appName) ||
    !pattern.includes(appName) ||
    !pattern.endsWith('*') ||
    pattern.slice(0, -1).includes('*')
  ) {
    throw new Error(`[entity-conformance] Refusing unsafe Redis cleanup pattern '${pattern}'`);
  }
  return pattern;
}

async function scanPattern(redis: RedisLike, pattern: string): Promise<string[]> {
  const prefix = pattern.slice(0, -1);
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    keys.push(...batch.filter(key => key.startsWith(prefix)));
  } while (cursor !== '0');
  return keys;
}

async function clearResources(resources: RedisResources): Promise<void> {
  const redis = resources.client as unknown as RedisLike;
  for (const pattern of resources.cleanupPatterns) {
    const keys = await scanPattern(redis, pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

async function createResources(
  definitions: readonly EntityConformanceDefinition[],
  profile: EntityBackendProfile,
  connectionString: string,
): Promise<RedisResources> {
  const { default: Redis } = await import('ioredis');
  const appName = `entity-conformance-${randomUUID().replaceAll('-', '')}`;
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new Error(`[entity-conformance] Invalid generated Redis app prefix '${appName}'`);
  }

  const client = new Redis(connectionString);
  try {
    await client.ping();
    const infra: StoreInfra = {
      appName,
      getTransactions: () => createUnsupportedTransactionManager(),
      getRedis() {
        return client as unknown as RedisLike;
      },
      getMongo() {
        throw new Error('[entity-conformance] MongoDB is unavailable in the Redis driver');
      },
      getSqliteDb() {
        throw new Error('[entity-conformance] SQLite is unavailable in the Redis driver');
      },
      getPostgres() {
        throw new Error('[entity-conformance] PostgreSQL is unavailable in the Redis driver');
      },
    };

    const safeDefinitions = definitions.map(definition => ({
      ...definition,
      config: withoutUnsupportedUniqueness(definition.config),
    }));
    const entries: Record<string, CompositeEntry> = {};
    for (const definition of safeDefinitions) {
      const operations = supportedOperations(profile, definition);
      entries[definition.key] = {
        config: definition.config,
        ...(operations ? { operations } : {}),
      };
    }
    const operations = Object.fromEntries(
      Object.entries(CONFORMANCE_COMPOSITE_OPERATIONS).filter(([, operation]) => {
        const capabilities =
          operation.kind === 'transaction'
            ? (['operation.transaction', 'transaction.rollback'] as const)
            : (['operation.pipe'] as const);
        return capabilities.every(
          capability => profile.capabilities[capability].status === 'supported',
        );
      }),
    );
    const cleanupPatterns = [
      ...new Set(safeDefinitions.map(definition => cleanupPattern(definition.config, appName))),
    ];
    return {
      client,
      cleanupPatterns,
      composite: createCompositeFactories(entries, operations).redis(infra),
    };
  } catch (error) {
    await client.quit();
    throw error;
  }
}

/**
 * Create a live Redis conformance driver.
 *
 * Every harness owns a cryptographically random validated application prefix.
 * Reset and destroy scan and delete only keys under the exact fixture prefixes.
 */
export function createRedisEntityConformanceDriver(
  connectionString = process.env['TEST_REDIS_URL'] ?? DEFAULT_REDIS_URL,
): EntityConformanceDriver {
  const profile = ENTITY_BACKEND_PROFILES.redis;
  return {
    name: 'redis',
    profile,
    async createHarness(
      definitions: readonly EntityConformanceDefinition[],
    ): Promise<EntityConformanceHarness> {
      const resources = await createResources(definitions, profile, connectionString);
      let destroyed = false;

      return {
        adapter<Entity, CreateInput, UpdateInput>(
          key: string,
        ): EntityAdapter<Entity, CreateInput, UpdateInput> {
          const value = resources.composite[key];
          if (typeof value !== 'object' || value === null) {
            throw new Error(`[entity-conformance] Unknown adapter '${key}'`);
          }
          return value as EntityAdapter<Entity, CreateInput, UpdateInput>;
        },
        composite(name: string): Readonly<Record<string, unknown>> {
          if (name !== CONFORMANCE_COMPOSITE_KEY) {
            throw new Error(`[entity-conformance] Unknown composite '${name}'`);
          }
          return resources.composite;
        },
        async reset(): Promise<void> {
          if (destroyed) {
            throw new Error('[entity-conformance] Cannot reset a destroyed Redis harness');
          }
          await clearResources(resources);
        },
        async destroy(): Promise<void> {
          if (destroyed) return;
          destroyed = true;
          try {
            await clearResources(resources);
          } finally {
            await resources.client.quit();
          }
        },
      };
    },
  };
}
