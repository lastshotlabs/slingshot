import { describe, expect, test } from 'bun:test';
import {
  EntityConcurrencyConflictError,
  EntityConcurrencyPreconditionError,
  SlingshotError,
  defineEntity,
  field,
} from '@lastshotlabs/slingshot-core';
import { createMemoryEntityAdapter } from '../../src/configDriven/memoryAdapter';
import { generateMemory } from '../../src/generators/memory';

const Versioned = defineEntity('MemoryVersioned', {
  fields: {
    id: field.string({ primary: true }),
    tenantId: field.string(),
    title: field.string(),
  },
  tenant: { field: 'tenantId' },
  concurrency: { strategy: 'version' },
});

function adapter() {
  return createMemoryEntityAdapter<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >(Versioned);
}

describe('memory optimistic concurrency', () => {
  test('forces version one on create and increments empty updates', async () => {
    const target = adapter();
    const created = await target.create({
      id: 'one',
      tenantId: 'alpha',
      title: 'initial',
      version: 99,
    });
    expect(created.version).toBe(1);

    const updated = await target.update('one', {}, undefined, { expectedVersion: 1 });
    expect(updated?.version).toBe(2);
  });

  test('distinguishes required preconditions, invalid values, conflicts, and scoped misses', async () => {
    const target = adapter();
    await target.create({ id: 'one', tenantId: 'alpha', title: 'initial' });

    await expect(target.update('one', { title: 'missing' })).rejects.toBeInstanceOf(
      EntityConcurrencyPreconditionError,
    );
    await expect(
      target.update('one', { title: 'invalid' }, undefined, { expectedVersion: Number.NaN }),
    ).rejects.toMatchObject({
      code: 'ENTITY_CONCURRENCY_EXPECTED_VERSION_INVALID',
    });
    await expect(
      target.update('one', { title: 'stale' }, undefined, { expectedVersion: 2 }),
    ).rejects.toBeInstanceOf(EntityConcurrencyConflictError);
    await expect(
      target.update('one', { title: 'hidden' }, { tenantId: 'beta' }, { expectedVersion: 2 }),
    ).resolves.toBeNull();
    await expect(target.delete('one', { tenantId: 'beta' }, { expectedVersion: 2 })).resolves.toBe(
      false,
    );
  });

  test('serializes same-version races to one winner and one conflict', async () => {
    const target = adapter();
    await target.create({ id: 'race', tenantId: 'alpha', title: 'initial' });

    const outcomes = await Promise.allSettled([
      target.update('race', { title: 'one' }, undefined, { expectedVersion: 1 }),
      target.update('race', { title: 'two' }, undefined, { expectedVersion: 1 }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'ENTITY_CONCURRENCY_CONFLICT' },
    });
    expect((await target.getById('race'))?.version).toBe(2);
  });

  test('generated memory adapters emit the same guarded-write contract', () => {
    const source = generateMemory(Versioned);
    expect(source).toContain('EntityConcurrencyPreconditionError');
    expect(source).toContain('EntityConcurrencyConflictError');
    expect(source).toContain("record['version'] = 1");
    expect(source).toContain("['version'] as number) + 1");
    expect(source).toContain('async update(id, input, filter, options)');
    expect(source).toContain('async delete(id, filter, options)');
  });

  test('concurrency errors remain transport-neutral Slingshot errors', () => {
    expect(new EntityConcurrencyPreconditionError('Thing', 'update')).toBeInstanceOf(
      SlingshotError,
    );
    expect(new EntityConcurrencyConflictError('Thing', 'one', 1)).toBeInstanceOf(SlingshotError);
  });
});
