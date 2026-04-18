import type { PgPool, PgQueryable } from './dbInterfaces';

export async function withOptionalPostgresTransaction<T>(
  db: PgPool,
  fn: (queryable: PgQueryable) => Promise<T>,
): Promise<T> {
  if (typeof db.connect !== 'function') {
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
