import { describe, expect, test } from 'bun:test';
import type { Connection } from 'mongoose';
import {
  EntityConcurrencyConflictError,
  EntityConcurrencyPreconditionError,
  defineEntity,
  field,
} from '@lastshotlabs/slingshot-core';
import { createMongoEntityAdapter } from '../../src/configDriven/mongoAdapter';

const Versioned = defineEntity('MongoVersioned', {
  concurrency: { strategy: 'version' },
  tenant: { field: 'tenantId' },
  fields: {
    id: field.string({ primary: true }),
    tenantId: field.string(),
    value: field.string(),
  },
});

function createFakeMongo() {
  const records = new Map<string, Record<string, unknown>>();
  const matches = (
    record: Record<string, unknown> | undefined,
    filter: Record<string, unknown>,
  ): record is Record<string, unknown> =>
    record !== undefined && Object.entries(filter).every(([key, value]) => record[key] === value);

  const model = {
    async create(document: Record<string, unknown>) {
      records.set(String(document._id), { ...document });
    },
    findOne(filter: Record<string, unknown>) {
      const record = records.get(String(filter._id));
      return { lean: () => Promise.resolve(matches(record, filter) ? { ...record } : null) };
    },
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
    ) {
      const record = records.get(String(filter._id));
      let result: Record<string, unknown> | null = null;
      if (matches(record, filter)) {
        Object.assign(record, update.$set);
        for (const [fieldName, increment] of Object.entries(update.$inc ?? {})) {
          record[fieldName] = Number(record[fieldName]) + increment;
        }
        result = { ...record };
      }
      return { lean: () => Promise.resolve(result) };
    },
    findOneAndDelete(filter: Record<string, unknown>) {
      const record = records.get(String(filter._id));
      const result = matches(record, filter) ? { ...record } : null;
      if (result) records.delete(String(filter._id));
      return { lean: () => Promise.resolve(result) };
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

  return {
    adapter: createMongoEntityAdapter<
      { id: string; tenantId: string; value: string; version: number },
      { id: string; tenantId: string; value: string },
      { value?: string }
    >(connection, { Schema }, Versioned),
  };
}

describe('MongoDB optimistic concurrency', () => {
  test('atomically increments one same-version winner and classifies scoped misses', async () => {
    const { adapter } = createFakeMongo();
    const created = await adapter.create({ id: 'A', tenantId: 'tenant-a', value: 'initial' });
    expect(created.version).toBe(1);

    await expect(adapter.update('A', { value: 'unguarded' })).rejects.toBeInstanceOf(
      EntityConcurrencyPreconditionError,
    );

    const race = await Promise.allSettled([
      adapter.update('A', { value: 'first' }, { tenantId: 'tenant-a' }, { expectedVersion: 1 }),
      adapter.update('A', { value: 'second' }, { tenantId: 'tenant-a' }, { expectedVersion: 1 }),
    ]);
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(
      (race.find(result => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(EntityConcurrencyConflictError);
    expect((await adapter.getById('A'))?.version).toBe(2);

    expect(
      await adapter.update(
        'A',
        { value: 'hidden' },
        { tenantId: 'tenant-b' },
        { expectedVersion: 1 },
      ),
    ).toBeNull();
    await expect(
      adapter.delete('A', { tenantId: 'tenant-a' }, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(EntityConcurrencyConflictError);
    expect(await adapter.delete('A', { tenantId: 'tenant-a' }, { expectedVersion: 2 })).toBe(true);
  });
});
