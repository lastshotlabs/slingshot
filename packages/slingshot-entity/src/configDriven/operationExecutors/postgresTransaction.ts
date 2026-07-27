import type { PgPool, PgQueryable } from './dbInterfaces';

const SCOPED_POSTGRES_QUERYABLE = Symbol.for('slingshot.scopedPostgresQueryable');

export async function withOptionalPostgresTransaction<T>(
  db: PgPool,
  fn: (queryable: PgQueryable) => Promise<T>,
): Promise<T> {
  const existingClient = db as PgPool & { release?: () => void };
  if (
    Reflect.get(db, SCOPED_POSTGRES_QUERYABLE) === true ||
    typeof existingClient.release === 'function' ||
    typeof db.connect !== 'function'
  ) {
    return fn(db);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure from the transactional body.
    }
    throw error;
  } finally {
    client.release?.();
  }
}
