import { describe, expect, test } from 'bun:test';
import type { TransitionOpConfig } from '@lastshotlabs/slingshot-core';
import { transitionPostgres } from '../../src/configDriven/operationExecutors/transition';

/**
 * Regression coverage for `transitionPostgres`.
 *
 * This executor shipped with its WHERE parameters transposed: the match columns
 * claimed `$n` first, but the `from` guard value was pushed into the values
 * array ahead of them. Every transition therefore ran as
 *
 *     UPDATE … SET status = 'published' WHERE id = 'draft' AND status = '<uuid>'
 *
 * which matches no row, so the route answered `200 null` and wrote nothing.
 * Downstream that meant a forum where no thread could ever be published — the
 * app's own e2e suite stayed green because the thread DETAIL page renders drafts.
 *
 * The fake pool below therefore does NOT pattern-match on hardcoded SQL. It
 * resolves `$n` placeholders positionally against the values array, exactly as
 * the driver does, so a transposition produces a genuine mismatch instead of
 * being absorbed by a fake that speaks the caller's language.
 */

interface Row {
  [column: string]: unknown;
}

/** Parses `col = $n` / `col IN ($a, $b)` conjunctions and binds them for real. */
function createPlaceholderPool(initialRows: Row[]) {
  const rows = initialRows.map((r) => ({ ...r }));
  const statements: { sql: string; values: unknown[] }[] = [];

  function evaluateWhere(clause: string, values: unknown[], row: Row): boolean {
    return clause
      .split(/\s+AND\s+/i)
      .every((term) => {
        const eq = term.match(/^\s*(\w+)\s*=\s*\$(\d+)\s*$/);
        if (eq) return row[eq[1]] === values[Number(eq[2]) - 1];

        const inList = term.match(/^\s*(\w+)\s+IN\s*\(([^)]*)\)\s*$/i);
        if (inList) {
          const candidates = inList[2]
            .split(',')
            .map((p) => values[Number(p.trim().replace('$', '')) - 1]);
          return candidates.includes(row[inList[1]]);
        }
        throw new Error(`fake pool cannot parse WHERE term: ${term}`);
      });
  }

  return {
    statements,
    rows,
    query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      const parsed = sql.match(/^UPDATE\s+(\S+)\s+SET\s+(.+?)\s+WHERE\s+(.+?)\s+RETURNING \*$/i);
      if (!parsed) throw new Error(`fake pool cannot parse SQL: ${sql}`);

      const assignments = parsed[2].split(',').map((piece) => {
        const [col, placeholder] = piece.split('=').map((s) => s.trim());
        return { col, value: values[Number(placeholder.replace('$', '')) - 1] };
      });

      const updated: Row[] = [];
      for (const row of rows) {
        if (!evaluateWhere(parsed[3], values, row)) continue;
        for (const { col, value } of assignments) row[col] = value;
        updated.push({ ...row });
      }
      return Promise.resolve({ rows: updated, rowCount: updated.length });
    },
  };
}

const publishOp: TransitionOpConfig = {
  kind: 'transition',
  field: 'status',
  from: 'draft',
  to: 'published',
  match: { id: 'param:id' },
  set: { publishedAt: 'now' },
  returns: 'entity',
} as TransitionOpConfig;

const identity = (row: Record<string, unknown>) => row;
const noop = () => Promise.resolve();

describe('transitionPostgres', () => {
  test('publishes the row whose id was passed, not the row matching the guard value', async () => {
    const pool = createPlaceholderPool([
      { id: 'thread-1', status: 'draft', published_at: null },
      { id: 'thread-2', status: 'draft', published_at: null },
    ]);

    const publish = transitionPostgres(publishOp, pool as never, 'threads', noop, identity);
    const result = await publish({ id: 'thread-2' });

    expect(result, 'the transition returned the updated row').not.toBeNull();
    expect((result as Row).id).toBe('thread-2');
    expect((result as Row).status).toBe('published');
    expect(pool.rows.find((r) => r.id === 'thread-2')?.status).toBe('published');
    // The untargeted row must be untouched — a transposed binding would either
    // match nothing or match the wrong row.
    expect(pool.rows.find((r) => r.id === 'thread-1')?.status).toBe('draft');
  });

  test('binds each WHERE placeholder to its own column', async () => {
    const pool = createPlaceholderPool([{ id: 'thread-1', status: 'draft', published_at: null }]);
    const publish = transitionPostgres(publishOp, pool as never, 'threads', noop, identity);
    await publish({ id: 'thread-1' });

    const { sql, values } = pool.statements[0];
    const idPlaceholder = sql.match(/id = \$(\d+)/)?.[1];
    const statusGuard = sql.match(/AND status = \$(\d+)/)?.[1];
    expect(idPlaceholder, 'the statement matches on id').toBeDefined();
    expect(statusGuard, 'the statement guards on the from-state').toBeDefined();

    // The actual defect, stated directly: the id placeholder must carry the id
    // and the guard placeholder must carry the `from` state.
    expect(values[Number(idPlaceholder) - 1]).toBe('thread-1');
    expect(values[Number(statusGuard) - 1]).toBe('draft');
  });

  test('refuses the transition when the row is not in the from-state', async () => {
    const pool = createPlaceholderPool([
      { id: 'thread-1', status: 'published', published_at: new Date() },
    ]);
    const publish = transitionPostgres(publishOp, pool as never, 'threads', noop, identity);

    expect(await publish({ id: 'thread-1' }), 'republishing is a no-op').toBeNull();
  });

  test('honours a multi-value from-state', async () => {
    const multiOp = { ...publishOp, from: ['draft', 'scheduled'] } as TransitionOpConfig;
    const pool = createPlaceholderPool([{ id: 'thread-9', status: 'scheduled', published_at: null }]);
    const publish = transitionPostgres(multiOp, pool as never, 'threads', noop, identity);

    const result = await publish({ id: 'thread-9' });
    expect((result as Row)?.status).toBe('published');
  });
});
