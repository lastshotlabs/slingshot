import { describe, expect, test } from 'bun:test';
import {
  evaluateFilter,
  extractFilterParams,
  extractMatchParams,
  resolveMatch,
} from '../../src/filterEvaluator';

describe('evaluateFilter', () => {
  // --- Field equality ---
  test('field equality match', () => {
    expect(evaluateFilter({ status: 'active' }, { status: 'active' })).toBe(true);
  });

  test('field equality mismatch', () => {
    expect(evaluateFilter({ status: 'active' }, { status: 'deleted' })).toBe(false);
  });

  test('number equality', () => {
    expect(evaluateFilter({ count: 42 }, { count: 42 })).toBe(true);
  });

  test('boolean equality', () => {
    expect(evaluateFilter({ active: true }, { active: true })).toBe(true);
    expect(evaluateFilter({ active: true }, { active: false })).toBe(false);
  });

  // --- Null checks ---
  test('null filter matches null', () => {
    expect(evaluateFilter({ deletedAt: null }, { deletedAt: null })).toBe(true);
  });

  test('null filter matches undefined', () => {
    expect(evaluateFilter({}, { deletedAt: null })).toBe(true);
  });

  test('null filter rejects non-null', () => {
    expect(evaluateFilter({ deletedAt: '2024-01-01' }, { deletedAt: null })).toBe(false);
  });

  // --- param:x references ---
  test('param reference resolves from params', () => {
    expect(
      evaluateFilter({ userId: 'usr_1' }, { userId: 'param:userId' }, { userId: 'usr_1' }),
    ).toBe(true);
  });

  test('param reference with missing param returns undefined (mismatch)', () => {
    expect(evaluateFilter({ userId: 'usr_1' }, { userId: 'param:missing' }, {})).toBe(false);
  });

  // --- 'now' sentinel ---
  test('now sentinel produces Date for comparison', () => {
    const past = new Date(Date.now() - 10000);
    expect(evaluateFilter({ expiresAt: past }, { expiresAt: { $lt: 'now' } })).toBe(true);
  });

  // --- $ne ---
  test('$ne operator', () => {
    expect(evaluateFilter({ status: 'active' }, { status: { $ne: 'deleted' } })).toBe(true);
    expect(evaluateFilter({ status: 'deleted' }, { status: { $ne: 'deleted' } })).toBe(false);
  });

  test('$ne with null: not-null check', () => {
    expect(evaluateFilter({ val: 'x' }, { val: { $ne: null } })).toBe(true);
    expect(evaluateFilter({ val: null }, { val: { $ne: null } })).toBe(false);
  });

  // --- $gt, $gte, $lt, $lte ---
  test('$gt number', () => {
    expect(evaluateFilter({ score: 10 }, { score: { $gt: 5 } })).toBe(true);
    expect(evaluateFilter({ score: 5 }, { score: { $gt: 5 } })).toBe(false);
  });

  test('$gte number', () => {
    expect(evaluateFilter({ score: 5 }, { score: { $gte: 5 } })).toBe(true);
    expect(evaluateFilter({ score: 4 }, { score: { $gte: 5 } })).toBe(false);
  });

  test('$lt number', () => {
    expect(evaluateFilter({ score: 3 }, { score: { $lt: 5 } })).toBe(true);
    expect(evaluateFilter({ score: 5 }, { score: { $lt: 5 } })).toBe(false);
  });

  test('$lte number', () => {
    expect(evaluateFilter({ score: 5 }, { score: { $lte: 5 } })).toBe(true);
    expect(evaluateFilter({ score: 6 }, { score: { $lte: 5 } })).toBe(false);
  });

  test('comparison with Date values', () => {
    const d1 = new Date('2024-01-01');
    const d2 = new Date('2024-06-01');
    expect(evaluateFilter({ date: d2 }, { date: { $gt: d1 } } as never)).toBe(true);
    expect(evaluateFilter({ date: d1 }, { date: { $gt: d2 } } as never)).toBe(false);
  });

  test('comparison with string values (lexicographic)', () => {
    expect(evaluateFilter({ name: 'banana' }, { name: { $gt: 'apple' } })).toBe(true);
    expect(evaluateFilter({ name: 'apple' }, { name: { $gt: 'banana' } })).toBe(false);
  });

  // --- $in, $nin ---
  test('$in operator', () => {
    expect(evaluateFilter({ role: 'admin' }, { role: { $in: ['admin', 'editor'] } })).toBe(true);
    expect(evaluateFilter({ role: 'viewer' }, { role: { $in: ['admin', 'editor'] } })).toBe(false);
  });

  test('$nin operator', () => {
    expect(evaluateFilter({ role: 'viewer' }, { role: { $nin: ['admin', 'editor'] } })).toBe(true);
    expect(evaluateFilter({ role: 'admin' }, { role: { $nin: ['admin', 'editor'] } })).toBe(false);
  });

  // --- $contains ---
  test('$contains case-insensitive substring', () => {
    expect(evaluateFilter({ title: 'Hello World' }, { title: { $contains: 'hello' } })).toBe(true);
    expect(evaluateFilter({ title: 'Hello World' }, { title: { $contains: 'xyz' } })).toBe(false);
  });

  test('$contains with null record value', () => {
    expect(evaluateFilter({ title: null }, { title: { $contains: 'test' } })).toBe(false);
  });

  test('$contains with null target via param', () => {
    expect(evaluateFilter({ title: 'Hello' }, { title: { $contains: 'param:q' } }, {})).toBe(true);
  });

  // --- $and, $or ---
  test('$and all must match', () => {
    const record = { status: 'active', score: 10 };
    expect(evaluateFilter(record, { $and: [{ status: 'active' }, { score: { $gte: 5 } }] })).toBe(
      true,
    );
    expect(evaluateFilter(record, { $and: [{ status: 'active' }, { score: { $gte: 20 } }] })).toBe(
      false,
    );
  });

  test('$or at least one must match', () => {
    const record = { status: 'deleted', score: 10 };
    expect(evaluateFilter(record, { $or: [{ status: 'active' }, { score: { $gte: 10 } }] })).toBe(
      true,
    );
    expect(evaluateFilter(record, { $or: [{ status: 'active' }, { score: { $gte: 20 } }] })).toBe(
      false,
    );
  });

  test('field conditions + $and + $or combined', () => {
    const record = { status: 'active', score: 15, level: 3 };
    expect(
      evaluateFilter(record, {
        status: 'active',
        $and: [{ score: { $gte: 10 } }],
        $or: [{ level: 5 }, { level: 3 }],
      }),
    ).toBe(true);
  });

  // --- Fallback strict equality ---
  test('fallback strict equality for unknown shape', () => {
    const record = { x: 42 };
    // Pass an operator object with no recognized key to trigger fallback
    const unknownOpData = { $unknown: true };
    const unknownOp: never = unknownOpData as never;
    expect(evaluateFilter(record, { x: unknownOp })).toBe(false);
  });

  // --- param:x in operator values ---
  test('$gt with param reference', () => {
    expect(evaluateFilter({ score: 10 }, { score: { $gt: 'param:min' } }, { min: 5 })).toBe(true);
  });

  test('$contains with param reference', () => {
    expect(
      evaluateFilter({ name: 'FooBar' }, { name: { $contains: 'param:q' } }, { q: 'foo' }),
    ).toBe(true);
  });
});

describe('extractFilterParams', () => {
  test('extracts top-level param references', () => {
    const params = extractFilterParams({ userId: 'param:userId', status: 'active' });
    expect(params).toEqual(['userId']);
  });

  test('extracts param from operator objects', () => {
    const params = extractFilterParams({ score: { $gte: 'param:min' } });
    expect(params).toEqual(['min']);
  });

  test('extracts from $and and $or', () => {
    const params = extractFilterParams({
      $and: [{ a: 'param:x' }],
      $or: [{ b: 'param:y' }],
    });
    expect(params).toContain('x');
    expect(params).toContain('y');
  });

  test('deduplicates param names', () => {
    const params = extractFilterParams({
      a: 'param:id',
      b: 'param:id',
    });
    expect(params).toEqual(['id']);
  });
});

describe('extractMatchParams', () => {
  test('extracts param references from match record', () => {
    const params = extractMatchParams({ id: 'param:id', status: 'active' });
    expect(params).toEqual(['id']);
  });

  test('ignores non-string and non-param values', () => {
    const params = extractMatchParams({ count: 5, flag: true, name: 'literal' });
    expect(params).toEqual([]);
  });
});

describe('resolveMatch', () => {
  test('resolves param references', () => {
    const resolved = resolveMatch({ id: 'param:id', status: 'active' }, { id: 'usr_123' });
    expect(resolved).toEqual({ id: 'usr_123', status: 'active' });
  });

  test('passes through literal values', () => {
    const resolved = resolveMatch({ count: 5, flag: true }, {});
    expect(resolved).toEqual({ count: 5, flag: true });
  });

  test('resolves now sentinel', () => {
    const resolved = resolveMatch({ timestamp: 'now' as never }, {});
    expect(resolved.timestamp).toBeInstanceOf(Date);
  });
});
