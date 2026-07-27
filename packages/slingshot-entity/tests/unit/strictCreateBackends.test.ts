import { describe, expect, test } from 'bun:test';
import type { Connection } from 'mongoose';
import { HttpError, type RedisLike, defineEntity, field } from '@lastshotlabs/slingshot-core';
import { createMongoEntityAdapter } from '../../src/configDriven/mongoAdapter';
import { createRedisEntityAdapter } from '../../src/configDriven/redisAdapter';

type Document = { id: string; value: string };

const StrictCreateEntity = defineEntity('StrictCreate', {
  fields: {
    id: field.string({ primary: true }),
    value: field.string(),
  },
});

async function expectConflict(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toMatchObject({
    status: 409,
    code: 'UNIQUE_VIOLATION',
  } satisfies Partial<HttpError>);
}

describe('strict create semantics', () => {
  test('Redis SET NX preserves an existing primary-key record', async () => {
    const values = new Map<string, string>();
    const redis = {
      get(key: string) {
        return Promise.resolve(values.get(key) ?? null);
      },
      set(key: string, value: string, ...args: unknown[]) {
        if (args.includes('NX') && values.has(key)) return Promise.resolve(null);
        values.set(key, value);
        return Promise.resolve('OK');
      },
    } as unknown as RedisLike;
    const adapter = createRedisEntityAdapter<Document, Document, Partial<Document>>(
      redis,
      'test',
      StrictCreateEntity,
    );

    await adapter.create({ id: 'A', value: 'original' });
    await expectConflict(adapter.create({ id: 'A', value: 'replacement' }));
    expect(await adapter.getById('A')).toEqual({ id: 'A', value: 'original' });
  });

  test('MongoDB insert preserves an existing primary-key record and normalizes E11000', async () => {
    const values = new Map<string, Record<string, unknown>>();
    const model = {
      async create(document: Record<string, unknown>) {
        const key = String(document._id);
        if (values.has(key)) {
          throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
        }
        values.set(key, { ...document });
      },
      findOne(filter: Record<string, unknown>) {
        return {
          lean: () => Promise.resolve(values.get(String(filter._id)) ?? null),
        };
      },
    };
    class Schema {
      static readonly Types = { Mixed: Object };
      index(): void {}
    }
    const connection = {
      models: {},
      model() {
        return model;
      },
    } as unknown as Connection;
    const adapter = createMongoEntityAdapter<Document, Document, Partial<Document>>(
      connection,
      { Schema },
      StrictCreateEntity,
    );

    await adapter.create({ id: 'A', value: 'original' });
    await expectConflict(adapter.create({ id: 'A', value: 'replacement' }));
    expect(await adapter.getById('A')).toEqual({ id: 'A', value: 'original' });
  });
});
