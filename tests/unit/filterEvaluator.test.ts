import { describe, expect, it } from 'bun:test';
import {
  evaluateFilter,
  extractFilterParams,
  extractMatchParams,
  resolveMatch,
} from '../../packages/slingshot-entity/src/configDriven/filterEvaluator';

describe('evaluateFilter', () => {
  describe('equality', () => {
    it('matches string equality', () => {
      expect(evaluateFilter({ status: 'active' }, { status: 'active' })).toBe(true);
      expect(evaluateFilter({ status: 'deleted' }, { status: 'active' })).toBe(false);
    });

    it('matches number equality', () => {
      expect(evaluateFilter({ score: 10 }, { score: 10 })).toBe(true);
      expect(evaluateFilter({ score: 5 }, { score: 10 })).toBe(false);
    });

    it('matches boolean equality', () => {
      expect(evaluateFilter({ active: true }, { active: true })).toBe(true);
      expect(evaluateFilter({ active: false }, { active: true })).toBe(false);
    });

    it('matches null', () => {
      expect(evaluateFilter({ deletedAt: null }, { deletedAt: null })).toBe(true);
      expect(evaluateFilter({ deletedAt: undefined }, { deletedAt: null })).toBe(true);
      expect(evaluateFilter({ deletedAt: 'something' }, { deletedAt: null })).toBe(false);
    });
  });

  describe('param resolution', () => {
    it('resolves param: references', () => {
      expect(evaluateFilter({ roomId: 'r1' }, { roomId: 'param:roomId' }, { roomId: 'r1' })).toBe(
        true,
      );
      expect(evaluateFilter({ roomId: 'r2' }, { roomId: 'param:roomId' }, { roomId: 'r1' })).toBe(
        false,
      );
    });
  });

  describe('$ne operator', () => {
    it('excludes matching values', () => {
      expect(evaluateFilter({ status: 'active' }, { status: { $ne: 'deleted' } })).toBe(true);
      expect(evaluateFilter({ status: 'deleted' }, { status: { $ne: 'deleted' } })).toBe(false);
    });

    it('handles $ne null (IS NOT NULL)', () => {
      expect(evaluateFilter({ deletedAt: '2024-01-01' }, { deletedAt: { $ne: null } })).toBe(true);
      expect(evaluateFilter({ deletedAt: null }, { deletedAt: { $ne: null } })).toBe(false);
    });
  });

  describe('comparison operators', () => {
    it('handles $gt', () => {
      expect(evaluateFilter({ score: 15 }, { score: { $gt: 10 } })).toBe(true);
      expect(evaluateFilter({ score: 10 }, { score: { $gt: 10 } })).toBe(false);
      expect(evaluateFilter({ score: 5 }, { score: { $gt: 10 } })).toBe(false);
    });

    it('handles $gte', () => {
      expect(evaluateFilter({ score: 10 }, { score: { $gte: 10 } })).toBe(true);
      expect(evaluateFilter({ score: 9 }, { score: { $gte: 10 } })).toBe(false);
    });

    it('handles $lt', () => {
      expect(evaluateFilter({ score: 5 }, { score: { $lt: 10 } })).toBe(true);
      expect(evaluateFilter({ score: 10 }, { score: { $lt: 10 } })).toBe(false);
    });

    it('handles $lte', () => {
      expect(evaluateFilter({ score: 10 }, { score: { $lte: 10 } })).toBe(true);
      expect(evaluateFilter({ score: 11 }, { score: { $lte: 10 } })).toBe(false);
    });
  });

  describe('set operators', () => {
    it('handles $in', () => {
      expect(evaluateFilter({ role: 'admin' }, { role: { $in: ['admin', 'owner'] } })).toBe(true);
      expect(evaluateFilter({ role: 'user' }, { role: { $in: ['admin', 'owner'] } })).toBe(false);
    });

    it('handles $nin', () => {
      expect(evaluateFilter({ role: 'user' }, { role: { $nin: ['banned', 'suspended'] } })).toBe(
        true,
      );
      expect(evaluateFilter({ role: 'banned' }, { role: { $nin: ['banned', 'suspended'] } })).toBe(
        false,
      );
    });
  });

  describe('$contains', () => {
    it('matches case-insensitive substring', () => {
      expect(evaluateFilter({ content: 'Hello World' }, { content: { $contains: 'hello' } })).toBe(
        true,
      );
      expect(evaluateFilter({ content: 'Hello World' }, { content: { $contains: 'WORLD' } })).toBe(
        true,
      );
      expect(evaluateFilter({ content: 'Hello World' }, { content: { $contains: 'xyz' } })).toBe(
        false,
      );
    });
  });

  describe('logical operators', () => {
    it('handles $and', () => {
      const record = { status: 'active', score: 15 };
      expect(
        evaluateFilter(record, {
          $and: [{ status: 'active' }, { score: { $gt: 10 } }],
        }),
      ).toBe(true);
      expect(
        evaluateFilter(record, {
          $and: [{ status: 'active' }, { score: { $gt: 20 } }],
        }),
      ).toBe(false);
    });

    it('handles $or', () => {
      const record = { role: 'moderator' };
      expect(
        evaluateFilter(record, {
          $or: [{ role: 'admin' }, { role: 'moderator' }],
        }),
      ).toBe(true);
      expect(
        evaluateFilter(record, {
          $or: [{ role: 'admin' }, { role: 'owner' }],
        }),
      ).toBe(false);
    });

    it('combines field conditions with $or', () => {
      const record = { status: 'active', role: 'moderator' };
      expect(
        evaluateFilter(record, {
          status: 'active',
          $or: [{ role: 'admin' }, { role: 'moderator' }],
        }),
      ).toBe(true);
      expect(
        evaluateFilter(record, {
          status: 'deleted',
          $or: [{ role: 'admin' }, { role: 'moderator' }],
        }),
      ).toBe(false);
    });
  });

  describe('multiple conditions (implicit AND)', () => {
    it('requires all field conditions to match', () => {
      const record = { status: 'active', roomId: 'r1', score: 10 };
      expect(evaluateFilter(record, { status: 'active', roomId: 'r1' })).toBe(true);
      expect(evaluateFilter(record, { status: 'active', roomId: 'r2' })).toBe(false);
    });
  });

  describe('empty filter', () => {
    it('matches everything', () => {
      expect(evaluateFilter({ anything: 'value' }, {})).toBe(true);
    });
  });
});

describe('extractFilterParams', () => {
  it('extracts param names', () => {
    const params = extractFilterParams({ roomId: 'param:roomId', status: 'active' });
    expect(params).toEqual(['roomId']);
  });

  it('extracts from nested operators', () => {
    const params = extractFilterParams({ score: { $gt: 'param:minScore' } });
    expect(params).toContain('minScore');
  });

  it('deduplicates', () => {
    const params = extractFilterParams({
      $and: [{ roomId: 'param:roomId' }],
      $or: [{ roomId: 'param:roomId' }],
    });
    expect(params).toEqual(['roomId']);
  });
});

describe('extractMatchParams', () => {
  it('extracts param names from match records', () => {
    expect(extractMatchParams({ id: 'param:id', status: 'active' })).toEqual(['id']);
    expect(extractMatchParams({ roomId: 'param:roomId', userId: 'param:userId' })).toEqual([
      'roomId',
      'userId',
    ]);
  });
});

describe('resolveMatch', () => {
  it('resolves param references', () => {
    const result = resolveMatch({ id: 'param:id', status: 'active' }, { id: 'abc123' });
    expect(result).toEqual({ id: 'abc123', status: 'active' });
  });
});
