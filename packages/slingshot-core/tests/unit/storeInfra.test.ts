import { describe, expect, test } from 'bun:test';
import { resolveRepo, resolveRepoAsync } from '../../src/storeInfra';
import type { RepoFactories, StoreInfra } from '../../src/storeInfra';

const mockInfra: StoreInfra = {} as never;

function makeFactories(results: Record<string, string>): RepoFactories<string> {
  return {
    memory: () => results.memory ?? 'mem',
    sqlite: () => results.sqlite ?? 'sqlite',
    redis: () => results.redis ?? 'redis',
    mongo: () => results.mongo ?? 'mongo',
    postgres: () => results.postgres ?? 'pg',
  };
}

describe('resolveRepo', () => {
  test('dispatches to memory factory', () => {
    const factories = makeFactories({ memory: 'memory-repo' });
    expect(resolveRepo(factories, 'memory', mockInfra)).toBe('memory-repo');
  });

  test('dispatches to sqlite factory', () => {
    const factories = makeFactories({ sqlite: 'sqlite-repo' });
    expect(resolveRepo(factories, 'sqlite', mockInfra)).toBe('sqlite-repo');
  });

  test('dispatches to redis factory', () => {
    const factories = makeFactories({ redis: 'redis-repo' });
    expect(resolveRepo(factories, 'redis', mockInfra)).toBe('redis-repo');
  });

  test('dispatches to mongo factory', () => {
    const factories = makeFactories({ mongo: 'mongo-repo' });
    expect(resolveRepo(factories, 'mongo', mockInfra)).toBe('mongo-repo');
  });

  test('dispatches to postgres factory', () => {
    const factories = makeFactories({ postgres: 'pg-repo' });
    expect(resolveRepo(factories, 'postgres', mockInfra)).toBe('pg-repo');
  });
});

describe('resolveRepoAsync', () => {
  test('resolves sync factory', async () => {
    const factories = makeFactories({ memory: 'async-mem' });
    const result = await resolveRepoAsync(factories, 'memory', mockInfra);
    expect(result).toBe('async-mem');
  });

  test('resolves async factory', async () => {
    const factories = {
      memory: async () => 'async-result',
      sqlite: () => 'x',
      redis: () => 'x',
      mongo: () => 'x',
      postgres: () => 'x',
    };
    const result = await resolveRepoAsync(factories, 'memory', mockInfra);
    expect(result).toBe('async-result');
  });
});
