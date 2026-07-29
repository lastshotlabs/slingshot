import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import Redis from 'ioredis';
import {
  ENTITY_BACKEND_CAPABILITIES,
  type OperationConfig,
  type StoreInfra,
  defineEntity,
  field,
} from '@lastshotlabs/slingshot-core';
import { createUnsupportedTransactionManager } from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, createEntityFactories } from '../../src/configDriven';
import {
  ENTITY_CONFORMANCE_CATALOG,
  ENTITY_CONFORMANCE_DEFINITIONS,
  createRedisEntityConformanceDriver,
  runEntityConformance,
} from '../../src/testing';

const TEST_REDIS_URL = process.env['TEST_REDIS_URL'];

const AtomicCounter = defineEntity('RedisConformanceAtomicCounter', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    count: field.integer({ default: 0 }),
  },
});

const Audit = defineEntity('RedisConformanceAudit', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    message: field.string(),
  },
});

const UniqueRecord = defineEntity('RedisConformanceUniqueRecord', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    email: field.string(),
  },
  uniques: [{ fields: ['email'] }],
});

const VersionedRecord = defineEntity('RedisConformanceVersionedRecord', {
  concurrency: { strategy: 'version' },
  fields: {
    id: field.string({ primary: true }),
    value: field.string(),
  },
});

const INCREMENT_OPERATIONS = {
  incrementCount: {
    kind: 'increment',
    field: 'count',
  },
} satisfies Record<string, OperationConfig>;

function noIoInfra(onRedisAccess: () => void): StoreInfra {
  const unavailable = (): never => {
    throw new Error('Infrastructure must not be accessed');
  };
  return {
    appName: 'entity-conformance-no-io',
    getTransactions: () => createUnsupportedTransactionManager(),
    getRedis() {
      onRedisAccess();
      throw new Error('Redis must not be accessed');
    },
    getMongo: unavailable,
    getSqliteDb: unavailable,
    getPostgres: unavailable,
  };
}

function assertPassed(results: Awaited<ReturnType<typeof runEntityConformance>>): void {
  expect(results.filter(result => result.status === 'failed')).toEqual([]);
}

test('unsupported Redis requirements reject before infrastructure access', () => {
  let redisAccesses = 0;
  const infra = noIoInfra(() => {
    redisAccesses += 1;
  });
  expect(() => createEntityFactories(UniqueRecord).redis(infra)).toThrow(/constraint\.unique/);
  expect(() => createEntityFactories(VersionedRecord).redis(infra)).toThrow(
    /concurrency\.version-update/,
  );
  expect(() => createEntityFactories(AtomicCounter, INCREMENT_OPERATIONS).redis(infra)).toThrow(
    /atomic\.increment/,
  );
  expect(() =>
    createCompositeFactories(
      {
        records: { config: AtomicCounter },
        audits: { config: Audit },
      },
      {
        rollbackPair: {
          kind: 'transaction',
          steps: [
            {
              op: 'create',
              entity: 'records',
              input: { id: 'param:recordId' },
            },
            {
              op: 'create',
              entity: 'audits',
              input: { id: 'param:auditId', message: 'param:message' },
            },
          ],
        },
      },
    ).redis(infra),
  ).toThrow(/transaction\.rollback/);
  expect(redisAccesses).toBe(0);
});

describe.skipIf(!TEST_REDIS_URL)('entity conformance — live Redis', () => {
  test('passes every claimed case for three consecutive catalog runs', async () => {
    const driver = createRedisEntityConformanceDriver(TEST_REDIS_URL);
    for (let run = 0; run < 3; run++) {
      const results = await runEntityConformance(driver);
      assertPassed(results);
      expect(results.map(result => result.caseId)).toEqual(
        ENTITY_CONFORMANCE_CATALOG.map(testCase => testCase.id),
      );
      expect(
        results.find(result => result.caseId === 'crud.primary-duplicate-conflict')?.status,
      ).toBe('passed');
      expect(results.find(result => result.caseId === 'race.duplicate-create')?.status).toBe(
        'passed',
      );
      expect(results.find(result => result.caseId === 'race.concurrent-increment')?.status).toBe(
        'skipped',
      );

      for (const capability of ENTITY_BACKEND_CAPABILITIES) {
        const hasSelectableCase = ENTITY_CONFORMANCE_CATALOG.some(
          testCase =>
            testCase.requires.includes(capability) &&
            testCase.requires.every(
              requirement => driver.profile.capabilities[requirement].status === 'supported',
            ),
        );
        if (driver.profile.capabilities[capability].status === 'supported' && hasSelectableCase) {
          expect(
            results.some(
              result =>
                result.status === 'passed' && result.requiredCapabilities.includes(capability),
            ),
          ).toBe(true);
        }
      }
    }
  }, 30_000);

  test('destroy is idempotent and prefix-scoped', async () => {
    if (!TEST_REDIS_URL) throw new Error('TEST_REDIS_URL is required');
    const redis = new Redis(TEST_REDIS_URL);
    const unrelatedKey = `entity-conformance-unrelated:${randomUUID()}`;
    await redis.set(unrelatedKey, 'preserve');
    try {
      const harness = await createRedisEntityConformanceDriver(TEST_REDIS_URL).createHarness(
        ENTITY_CONFORMANCE_DEFINITIONS,
      );
      await harness
        .adapter<Record<string, unknown>, Record<string, unknown>>('audits')
        .create({ id: 'cleanup-owned', recordId: 'cleanup', message: 'owned' });
      await harness.destroy();
      await harness.destroy();
      expect(await redis.get(unrelatedKey)).toBe('preserve');
    } finally {
      await redis.del(unrelatedKey);
      await redis.quit();
    }
  });
});
