import { describe, expect, test } from 'bun:test';
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import {
  normalizeEntityListResult,
  normalizeEntityRecordResult,
  normalizeNamedOperationHttpResult,
} from '../../src/lib/normalizeEntityHttpResult';

const entityConfig = {
  fields: {
    id: { type: 'string' },
    publishedAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
} as unknown as ResolvedEntityConfig;

describe('normalize entity HTTP results', () => {
  test('serializes date fields in record results without mutating unchanged values', () => {
    const publishedAt = new Date('2026-04-01T12:00:00.000Z');
    const record = {
      id: 'post-1',
      publishedAt,
      title: 'Release notes',
    };

    const normalized = normalizeEntityRecordResult(entityConfig, record);

    expect(normalized).toEqual({
      id: 'post-1',
      publishedAt: '2026-04-01T12:00:00.000Z',
      title: 'Release notes',
    });
    expect(record.publishedAt).toBe(publishedAt);
    expect(normalizeEntityRecordResult(entityConfig, { id: 'post-2' })).toEqual({ id: 'post-2' });
    expect(normalizeEntityRecordResult(entityConfig, null)).toBeNull();
    expect(normalizeEntityRecordResult(entityConfig, ['post-1'])).toEqual(['post-1']);
  });

  test('serializes date fields inside list results', () => {
    const page = {
      items: [
        { id: 'post-1', publishedAt: new Date('2026-04-01T12:00:00.000Z') },
        { id: 'post-2', updatedAt: '2026-04-02T12:00:00.000Z' },
      ],
      nextCursor: 'cursor-1',
    };

    expect(normalizeEntityListResult(entityConfig, page)).toEqual({
      items: [
        { id: 'post-1', publishedAt: '2026-04-01T12:00:00.000Z' },
        { id: 'post-2', updatedAt: '2026-04-02T12:00:00.000Z' },
      ],
      nextCursor: 'cursor-1',
    });
    expect(normalizeEntityListResult(entityConfig, { items: 'not-a-list' })).toEqual({
      items: 'not-a-list',
    });
  });

  test('normalizes only lookup operation HTTP results', () => {
    const oneLookup = {
      kind: 'lookup',
      returns: 'one',
    } as unknown as OperationConfig;
    const manyLookup = {
      kind: 'lookup',
      returns: 'many',
    } as unknown as OperationConfig;
    const action = {
      kind: 'action',
      returns: 'one',
    } as unknown as OperationConfig;
    const record = { id: 'post-1', publishedAt: new Date('2026-04-01T12:00:00.000Z') };
    const page = { items: [record] };

    expect(normalizeNamedOperationHttpResult(entityConfig, oneLookup, record)).toEqual({
      id: 'post-1',
      publishedAt: '2026-04-01T12:00:00.000Z',
    });
    expect(normalizeNamedOperationHttpResult(entityConfig, manyLookup, page)).toEqual({
      items: [{ id: 'post-1', publishedAt: '2026-04-01T12:00:00.000Z' }],
    });
    expect(normalizeNamedOperationHttpResult(entityConfig, action, record)).toBe(record);
  });
});
