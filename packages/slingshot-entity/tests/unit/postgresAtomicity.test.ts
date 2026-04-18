import { describe, expect, test } from 'bun:test';
import {
  type ArrayPullOpConfig,
  type ArrayPushOpConfig,
  type CollectionOpConfig,
  type ComputedAggregateOpConfig,
  defineEntity,
  field,
} from '@lastshotlabs/slingshot-core';
import { arrayPullPostgres } from '../../src/configDriven/operationExecutors/arrayPull';
import { arrayPushPostgres } from '../../src/configDriven/operationExecutors/arrayPush';
import { collectionPostgres } from '../../src/configDriven/operationExecutors/collection';
import { computedAggregatePostgres } from '../../src/configDriven/operationExecutors/computedAggregate';

type PgRow = Record<string, unknown>;

function cloneRows(rows: PgRow[]): PgRow[] {
  return rows.map(row => ({ ...row }));
}

function createComputedAggregatePool(initialRows: PgRow[]) {
  const state = { rows: cloneRows(initialRows) };
  const clientQueries: string[] = [];
  const released = { count: 0 };
  let workingRows: PgRow[] | null = null;

  const query = (sql: string, params: unknown[] = []) => {
    clientQueries.push(sql);
    if (sql === 'BEGIN') {
      workingRows = cloneRows(state.rows);
      return Promise.resolve({ rows: [], rowCount: null });
    }
    if (sql === 'COMMIT') {
      if (workingRows) state.rows = workingRows;
      workingRows = null;
      return Promise.resolve({ rows: [], rowCount: null });
    }
    if (sql === 'ROLLBACK') {
      workingRows = null;
      return Promise.resolve({ rows: [], rowCount: null });
    }

    const targetRows = workingRows ?? state.rows;
    if (sql.startsWith('SELECT * FROM summary_table')) {
      return Promise.resolve({ rows: cloneRows(targetRows), rowCount: targetRows.length });
    }
    if (sql.startsWith('UPDATE summary_table SET summary = $1 WHERE id = $2')) {
      const row = targetRows.find(entry => entry.id === params[1]);
      if (!row) throw new Error('target row missing');
      row.summary = params[0];
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  };

  return {
    pool: {
      connect() {
        return Promise.resolve({
          query,
          release() {
            released.count += 1;
          },
        });
      },
      query() {
        return Promise.reject(new Error('atomic executor should use a checked-out client'));
      },
    },
    state,
    clientQueries,
    released,
  };
}

function createCollectionPool(initialRows: PgRow[], failOnId?: string) {
  const state = { rows: cloneRows(initialRows) };
  const clientQueries: string[] = [];
  const released = { count: 0 };
  let workingRows: PgRow[] | null = null;

  const query = (sql: string, params: unknown[] = []) => {
    clientQueries.push(sql);
    if (sql === 'BEGIN') {
      workingRows = cloneRows(state.rows);
      return Promise.resolve({ rows: [], rowCount: null });
    }
    if (sql === 'COMMIT') {
      if (workingRows) state.rows = workingRows;
      workingRows = null;
      return Promise.resolve({ rows: [], rowCount: null });
    }
    if (sql === 'ROLLBACK') {
      workingRows = null;
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS parent_table_items')) {
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith('DELETE FROM parent_table_items WHERE parent_id = $1')) {
      const parentId = params[0];
      if (workingRows) {
        workingRows = workingRows.filter(row => row.parent_id !== parentId);
      } else {
        state.rows = state.rows.filter(row => row.parent_id !== parentId);
      }
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith('INSERT INTO parent_table_items')) {
      const [parentId, id, label] = params;
      if (id === failOnId) {
        throw new Error('insert failed');
      }
      const nextRow = { parent_id: parentId, id, label };
      if (workingRows) {
        workingRows.push(nextRow);
      } else {
        state.rows.push(nextRow);
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  };

  return {
    pool: {
      connect() {
        return Promise.resolve({
          query,
          release() {
            released.count += 1;
          },
        });
      },
      query(sql: string, params?: unknown[]) {
        return query(sql, params);
      },
    },
    state,
    clientQueries,
    released,
  };
}

function createArrayMutationPool(initialRows: PgRow[], failOnUpdate = false) {
  const state = { rows: cloneRows(initialRows) };
  const clientQueries: string[] = [];
  const released = { count: 0 };
  let workingRows: PgRow[] | null = null;

  const query = (sql: string, params: unknown[] = []) => {
    clientQueries.push(sql);
    if (sql === 'BEGIN') {
      workingRows = cloneRows(state.rows);
      return Promise.resolve({ rows: [], rowCount: null });
    }
    if (sql === 'COMMIT') {
      if (workingRows) state.rows = workingRows;
      workingRows = null;
      return Promise.resolve({ rows: [], rowCount: null });
    }
    if (sql === 'ROLLBACK') {
      workingRows = null;
      return Promise.resolve({ rows: [], rowCount: null });
    }

    const targetRows = workingRows ?? state.rows;
    if (sql.startsWith('SELECT * FROM article_table WHERE id = $1 FOR UPDATE')) {
      const row = targetRows.find(entry => entry.id === params[0]);
      return Promise.resolve({ rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 });
    }
    if (sql.startsWith('UPDATE article_table SET tags = $2 WHERE id = $1 RETURNING *')) {
      if (failOnUpdate) {
        throw new Error('update failed');
      }
      const row = targetRows.find(entry => entry.id === params[0]);
      if (!row) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      row.tags = params[1];
      return Promise.resolve({ rows: [{ ...row }], rowCount: 1 });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  };

  return {
    pool: {
      connect() {
        return Promise.resolve({
          query,
          release() {
            released.count += 1;
          },
        });
      },
      query(sql: string, params?: unknown[]) {
        return query(sql, params);
      },
    },
    state,
    clientQueries,
    released,
  };
}

describe('Postgres executor atomicity', () => {
  test('computedAggregate uses BEGIN/COMMIT when atomic is true', async () => {
    const Summary = defineEntity('Summary', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        kind: field.string(),
        summary: field.json({ optional: true }),
      },
    });

    const op: ComputedAggregateOpConfig = {
      kind: 'computedAggregate',
      source: 'summary',
      target: 'summary',
      sourceFilter: { kind: 'comment' },
      compute: { count: 'count' },
      materializeTo: 'summary',
      targetMatch: { id: 'param:id' },
      atomic: true,
    };

    const { pool, state, clientQueries, released } = createComputedAggregatePool([
      { id: 'comment-1', kind: 'comment', summary: null },
      { id: 'comment-2', kind: 'comment', summary: null },
      { id: 'target', kind: 'post', summary: null },
    ]);

    const executor = computedAggregatePostgres(op, Summary, pool, 'summary_table', async () => {});
    await executor({ id: 'target' });

    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('COMMIT');
    expect(released.count).toBe(1);
    expect(state.rows.find(row => row.id === 'target')?.summary).toBe(JSON.stringify({ count: 2 }));
  });

  test('collection set rolls back all writes on failure', async () => {
    const Parent = defineEntity('Parent', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
      },
    });

    const op: CollectionOpConfig = {
      kind: 'collection',
      parentKey: 'parentId',
      itemFields: {
        id: field.string(),
        label: field.string(),
      },
      operations: ['set'],
      identifyBy: 'id',
    };

    const { pool, state, clientQueries, released } = createCollectionPool(
      [{ parent_id: 'p1', id: 'existing', label: 'Existing' }],
      'bad',
    );

    const collection = collectionPostgres(
      'items',
      op,
      Parent,
      pool,
      'parent_table',
      async () => {},
    );
    if (!collection.set) {
      throw new Error('expected collection.set to be defined');
    }

    const setCollection = collection.set;

    let error: Error | null = null;
    try {
      await setCollection('p1', [
        { id: 'ok', label: 'Ok' },
        { id: 'bad', label: 'Bad' },
      ]);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).toBe('insert failed');

    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('ROLLBACK');
    expect(released.count).toBe(1);
    expect(state.rows).toEqual([{ parent_id: 'p1', id: 'existing', label: 'Existing' }]);
  });

  test('arrayPush uses BEGIN/COMMIT and updates the row once', async () => {
    const Article = defineEntity('Article', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        tags: field.string({ array: true, optional: true }),
      },
    });

    const op: ArrayPushOpConfig = {
      kind: 'arrayPush',
      field: 'tags',
      value: 'input:tag',
    };

    const { pool, state, clientQueries, released } = createArrayMutationPool([
      { id: 'a1', tags: ['news'] },
    ]);

    const executor = arrayPushPostgres(
      op,
      Article,
      pool,
      'article_table',
      async () => {},
      row => row,
    );
    const updated = await executor('a1', 'tech');

    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('COMMIT');
    expect(released.count).toBe(1);
    expect(updated.tags).toBe(JSON.stringify(['news', 'tech']));
    expect(state.rows).toEqual([{ id: 'a1', tags: JSON.stringify(['news', 'tech']) }]);
  });

  test('arrayPull rolls back on Postgres update failure', async () => {
    const Article = defineEntity('Article', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        tags: field.string({ array: true, optional: true }),
      },
    });

    const op: ArrayPullOpConfig = {
      kind: 'arrayPull',
      field: 'tags',
      value: 'input:tag',
    };

    const { pool, state, clientQueries, released } = createArrayMutationPool(
      [{ id: 'a1', tags: ['news', 'tech'] }],
      true,
    );

    const executor = arrayPullPostgres(
      op,
      Article,
      pool,
      'article_table',
      async () => {},
      row => row,
    );

    let error: Error | null = null;
    try {
      await executor('a1', 'tech');
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).toBe('update failed');
    expect(clientQueries).toContain('BEGIN');
    expect(clientQueries).toContain('ROLLBACK');
    expect(released.count).toBe(1);
    expect(state.rows).toEqual([{ id: 'a1', tags: ['news', 'tech'] }]);
  });
});
